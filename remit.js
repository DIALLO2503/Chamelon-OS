import { pool, tx, one, all } from '../db.js'
import { REGIONS, PRICING, CURRENCIES } from '../catalog.js'
import { post, sys, expand, legs } from '../ledger.js'
import { fail, newId, today, convert, money, mask, ago, longDate, formatRate, rateE8, fmt } from '../core.js'
import { rowsBlock, ctxFor, walletOf } from '../context.js'
import { notify, payoutHandlers } from '../rails.js'
import { log } from '../log.js'
import { amountField, phoneField, textField, regionOfPhone, assertCorridor, deliver } from './shared.js'
import { levelOf } from './work.js'

const beneficiaries = ctx => all(ctx.client, `SELECT b.*, p.phone, p.user_id FROM beneficiaries b JOIN parties p ON p.id=b.party_id WHERE b.user_id=$1 ORDER BY b.created_at`, [ctx.user.id])
async function beneficiary(ctx, id) {
  const b = await one(ctx.client, `SELECT b.*, p.phone, p.user_id FROM beneficiaries b JOIN parties p ON p.id=b.party_id WHERE b.id=$1 AND b.user_id=$2`, [id, ctx.user.id])
  return b ?? fail('Proche introuvable', 404)
}
// The sending fee falls as the sender's reputation level rises.
const feeFor = (ctx, toRegion, level = 0) => (toRegion === ctx.user.region ? 0 : Math.round(PRICING.remitFee[ctx.cur.code] * PRICING.remitFeeByLevel[level]))
const toField = async ctx => ({ name: 'to', label: 'Destinataire', type: 'select', options: (await beneficiaries(ctx)).map(b => ({ value: b.id, label: `${b.name} · ${REGIONS[b.region].name}` })) })
const needsBeneficiary = { info: 'Ajoutez d’abord un proche (son numéro suffit, il n’a pas besoin de l’application).', fields: [], blocked: true }

payoutHandlers.succeeded.remit = (c, op) => c.query(`UPDATE remittances SET status='delivered' WHERE id=$1`, [op.purpose.remittanceId])
// The recipient's number was refused: the sender gets back the full amount sent, in their currency (the fee is kept only if delivery succeeded).
payoutHandlers.failed.remit = async (c, op, source) => {
  const r = await one(c, `UPDATE remittances SET status='failed' WHERE id=$1 RETURNING *`, [op.purpose.remittanceId])
  const sender = await one(c, 'SELECT * FROM users WHERE id=$1', [r.sender_id])
  const wallet = await walletOf(c, sender)
  await post(c, { kind: 'payout_reversed', idem: `remit-refund:${op.id}`, lines: await expand(c, [legs(source, wallet, op.amount, r.amount, { to: { title: 'Envoi non délivré, remboursé', icon: 'rotate-ccw' } })]) })
  if (r.fee) await post(c, { kind: 'payout_reversed', idem: `remit-fee-refund:${op.id}`, lines: [{ account: await sys(c, 'fees', r.currency), amount: -r.fee }, { account: wallet, amount: r.fee, title: 'Frais d’envoi remboursés', icon: 'rotate-ccw' }] })
  await notify(c, { userId: sender.id, template: 'remit.failed', text: `Votre envoi de ${money(r.amount, r.currency)} n’a pas pu être délivré (numéro refusé). Vous êtes remboursé, frais compris.` })
}

export async function sendPlan(ctx, input, rowId) {
  const b = await beneficiary(ctx, rowId ?? input.to)
  assertCorridor(ctx, b.region, 'remit')
  const to = REGIONS[b.region].currency.code
  const level = await levelOf(ctx)
  const a = input.amount, fee = feeFor(ctx, b.region, level), received = convert(a, ctx.cur.code, to, 'down')
  if (received <= 0) fail('Montant trop faible')
  const cross = to !== ctx.cur.code
  const rate = rateE8(ctx.cur.code, to).toString()
  return {
    review: { lines: [
      ['Destinataire', b.name], ['Montant envoyé', ctx.f(a)], [level >= 2 && b.region !== ctx.user.region ? `Frais (réduits, niveau ${level + 1})` : 'Frais', ctx.f(fee)],
      ...(cross ? [['Taux', `${fmt(10 ** ctx.cur.decimals, ctx.cur)} = ${formatRate(ctx.cur.code, to)} ${CURRENCIES[to].symbol}`]] : []),
      [`${b.name} reçoit`, money(received, to), true], ['Total débité', ctx.f(a + fee)]], cta: `Envoyer ${ctx.f(a)}`, rate },
    async exec() {
      const wallet = await ctx.wallet()
      const party = await one(ctx.client, 'SELECT * FROM parties WHERE id=$1', [b.party_id])
      if (fee) await post(ctx.client, { kind: 'remit_fee', lines: [{ account: wallet, amount: -fee, title: 'Frais d’envoi', cpParty: party.id, icon: 'globe' }, { account: await sys(ctx.client, 'fees', ctx.cur.code), amount: fee }] })
      // Debit the sender into a transit account, then deliver from it (wallet credit or mobile-money payout).
      const transit = await sys(ctx.client, 'remit_transit', ctx.cur.code)
      await post(ctx.client, { kind: 'remit', lines: [{ account: wallet, amount: -a, title: 'Envoi au pays', cpParty: party.id, icon: 'globe' }, { account: transit, amount: a }] })
      const remitId = newId()
      const r = await deliver(ctx.client, { source: transit, amount: a, toParty: party, title: `Reçu de ${mask(ctx.user.name)}`, purpose: { type: 'remit', remittanceId: remitId }, kind: 'remit' })
      await ctx.client.query('INSERT INTO remittances (id, sender_id, party_id, currency, amount, fee, to_currency, received, rate_e8, delivery, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [remitId, ctx.user.id, party.id, ctx.cur.code, a, fee, to, r.received, rate, r.via, r.via === 'wallet' ? 'delivered' : 'in_transit'])
      await notify(ctx.client, { partyId: party.id, template: 'remit.received', text: `${mask(ctx.user.name)} vous a envoyé ${money(r.received, to)}${r.via === 'payout' ? ' sur votre mobile money' : ''}.` })
      return { message: r.via === 'wallet' ? `${b.name} a reçu ${money(r.received, to)}` : `${money(r.received, to)} en route vers le mobile money de ${b.name}` }
    },
  }
}

function nextRun(day, from = today()) {
  const d = new Date(`${from.slice(0, 8)}${String(day).padStart(2, '0')}T00:00:00Z`)
  if (d.toISOString().slice(0, 10) <= from) d.setUTCMonth(d.getUTCMonth() + 1)
  return d.toISOString().slice(0, 10)
}

// Each due schedule runs in its own transaction keyed by schedule and period, so a crash or a second process cannot pay twice.
export async function runDueSchedules(date = today()) {
  const due = await all(pool, 'SELECT * FROM remit_schedules WHERE next_run <= $1', [date])
  for (const s of due) {
    const period = s.next_run
    try {
      await tx(async c => {
        const locked = await one(c, 'SELECT * FROM remit_schedules WHERE id=$1 AND next_run=$2 FOR UPDATE SKIP LOCKED', [s.id, period])
        if (!locked) return
        const ctx = await ctxFor(c, s.user_id)
        const claimed = await c.query(`INSERT INTO idempotency (user_id, key, request_hash) VALUES ($1,$2,'schedule') ON CONFLICT DO NOTHING`, [s.user_id, `schedule:${s.id}:${period}`])
        if (claimed.rowCount) {
          try {
            await c.query('SAVEPOINT pay')
            await (await sendPlan(ctx, { amount: s.amount }, s.beneficiary_id)).exec()
            await c.query('UPDATE remit_schedules SET note=NULL WHERE id=$1', [s.id])
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT pay')
            await c.query('UPDATE remit_schedules SET note=$2 WHERE id=$1', [s.id, e.message])
            await notify(c, { userId: s.user_id, template: 'remit.schedule_failed', text: `Votre envoi programmé n’a pas pu partir : ${e.message}` })
          }
        }
        await c.query('UPDATE remit_schedules SET next_run=$2 WHERE id=$1', [s.id, nextRun(s.day, period)])
      })
    } catch (e) { log.error({ err: e, schedule: s.id }, 'schedule run failed') }
  }
}

const quoteRows = ctx => ctx.region.corridors.map(id => {
  const to = REGIONS[id].currency, unit = 100 * 10 ** ctx.cur.decimals
  return { id, title: `Vers ${REGIONS[id].name}`, sub: `Pour ${ctx.f(unit)} envoyés · frais ${ctx.f(PRICING.remitFee[ctx.cur.code])}`, value: fmt(convert(unit, ctx.cur.code, to.code), to) }
})
const beneficiaryRows = async ctx => (await beneficiaries(ctx)).map(b => ({ id: b.id, title: b.name, sub: [b.relation, REGIONS[b.region].name, b.user_id ? 'a un compte Nexus' : 'reçoit sur son mobile money'].filter(Boolean).join(' · '),
  actions: ctx.held && (b.region === ctx.user.region || ctx.region.corridors.includes(b.region)) ? [{ id: 'send', label: 'Envoyer', tone: 'primary' }] : [] }))
const senderRows = async ctx => (await all(ctx.client, `SELECT r.sender_id, u.name, u.region, SUM(r.received)::bigint AS total, MAX(r.created_at) AS last, MAX(r.to_currency) AS cur
    FROM remittances r JOIN users u ON u.id=r.sender_id WHERE r.party_id=$1 GROUP BY r.sender_id, u.name, u.region ORDER BY last DESC`, [ctx.party.id]))
  .map(r => ({ id: r.sender_id, title: `${mask(r.name)} · ${REGIONS[r.region].name}`, sub: `Dernier envoi : ${ago(r.last).toLowerCase()}`, value: money(r.total, r.cur) }))

const sendAction = {
  label: 'Envoyer au pays', icon: 'globe', custody: 'held',
  async form(ctx, rowId) {
    if (!(await beneficiaries(ctx)).length) return { title: 'Envoyer au pays', ...needsBeneficiary }
    return { title: 'Envoyer au pays', fields: [amountField('Montant à envoyer'), ...(rowId ? [] : [await toField(ctx)])] }
  },
  plan: sendPlan,
}

export const remit = {
  async view(ctx) {
    const schedules = (await all(ctx.client, 'SELECT s.*, b.name FROM remit_schedules s JOIN beneficiaries b ON b.id=s.beneficiary_id WHERE s.user_id=$1', [ctx.user.id]))
      .map(s => ({ id: s.id, title: `${s.name} · le ${s.day} de chaque mois`, sub: s.note ? `Dernier essai : ${s.note}` : `Prochain envoi le ${longDate(s.next_run)}`, value: ctx.f(s.amount), status: s.note ? 'Échec' : 'Programmé', tone: s.note ? 'bad' : 'ok', actions: [{ id: 'unschedule', label: 'Arrêter' }] }))
    const sent = (await all(ctx.client, 'SELECT r.*, p.name FROM remittances r JOIN parties p ON p.id=r.party_id WHERE r.sender_id=$1 ORDER BY r.created_at DESC LIMIT 10', [ctx.user.id]))
      .map(r => ({ id: r.id, title: r.name, sub: `${ago(r.created_at)} · reçu ${money(r.received, r.to_currency)}${r.delivery === 'payout' ? ' (mobile money)' : ''}`, value: ctx.f(r.amount) }))
    return { blocks: [
      rowsBlock('Taux du jour (bac à sable)', 'globe', quoteRows(ctx)),
      rowsBlock('Vos proches', 'heart-handshake', await beneficiaryRows(ctx), 'Ajoutez un proche pour lui envoyer de l’argent.'),
      rowsBlock('Envois programmés', 'calendar-clock', schedules), rowsBlock('Envois récents', 'globe', sent)],
      actions: ['send', 'schedule'] }
  },
  widgets: { rows: async ctx => rowsBlock(null, 'globe', quoteRows(ctx)) },
  actions: {
    send: sendAction,
    schedule: {
      label: 'Programmer un envoi', icon: 'calendar-clock', custody: 'held',
      async form(ctx) {
        if (!(await beneficiaries(ctx)).length) return { title: 'Programmer un envoi', ...needsBeneficiary }
        return { title: 'Programmer un envoi', info: 'L’envoi part chaque mois si votre solde le permet ; sinon vous êtes prévenu.', fields: [amountField('Montant mensuel'), await toField(ctx), { name: 'day', label: 'Jour du mois (1 à 28)', type: 'number', min: 1, max: 28 }] }
      },
      async run(ctx, input) {
        const b = await beneficiary(ctx, input.to)
        assertCorridor(ctx, b.region, 'remit')
        await ctx.client.query('INSERT INTO remit_schedules (id, user_id, beneficiary_id, amount, day, next_run) VALUES ($1,$2,$3,$4,$5,$6)', [newId(), ctx.user.id, b.id, input.amount, input.day, nextRun(input.day)])
        return { message: `${ctx.f(input.amount)} seront envoyés à ${b.name} le ${input.day} de chaque mois` }
      },
    },
    unschedule: {
      label: 'Arrêter', form: () => ({ title: 'Arrêter l’envoi programmé', fields: [] }),
      async run(ctx, input, rowId) { const r = await ctx.client.query('DELETE FROM remit_schedules WHERE id=$1 AND user_id=$2', [rowId, ctx.user.id]); if (!r.rowCount) fail('Introuvable', 404); return { message: 'Envoi programmé arrêté' } },
    },
  },
}

export const family = {
  async view(ctx) {
    return { blocks: [
      rowsBlock('Vous envoyez à', 'heart-handshake', await beneficiaryRows(ctx), ctx.region.corridors.length ? 'Ajoutez un proche pour lui envoyer de l’argent.' : undefined),
      rowsBlock('Vous recevez de', 'arrow-down-left', await senderRows(ctx), ctx.region.corridors.length ? undefined : 'Vos proches à l’étranger apparaîtront ici dès leur premier envoi.')],
      actions: ['add'] }
  },
  widgets: { rows: async (ctx, w) => (w.source === 'senders' ? rowsBlock(null, 'arrow-down-left', await senderRows(ctx)) : rowsBlock(null, 'heart-handshake', await beneficiaryRows(ctx))) },
  actions: {
    send: sendAction,
    add: {
      label: 'Ajouter un proche', icon: 'user-round-plus',
      form: () => ({ title: 'Ajouter un proche', info: 'Il n’a pas besoin de l’application : sans compte, il reçoit l’argent sur son mobile money.', fields: [
        phoneField('Son numéro', { hint: "S'il vit dans un autre pays, commencez par l'indicatif (+221, +212, +224…)." }),
        textField('name', 'Nom à afficher'), textField('relation', 'Lien (mère, frère…)', { required: false })] }),
      async run(ctx, input) {
        const party = await ctx.findParty(input.phone, input.name)
        const region = regionOfPhone(party.phone)
        if (!region) fail('Pays non pris en charge')
        if (region !== ctx.user.region && !ctx.region.corridors.includes(region)) fail(`Les envois vers ${REGIONS[region].name} ne sont pas ouverts depuis ${ctx.region.name}`)
        const r = await ctx.client.query('INSERT INTO beneficiaries (id, user_id, party_id, region, name, relation) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, party_id) DO NOTHING', [newId(), ctx.user.id, party.id, region, input.name, input.relation ?? null])
        if (!r.rowCount) fail('Ce proche est déjà dans votre liste')
        return { message: `${input.name} ajouté à vos proches` }
      },
    },
  },
}
