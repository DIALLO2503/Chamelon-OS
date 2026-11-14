import { one, all, transition } from '../db.js'
import { config } from '../config.js'
import { REGIONS, CURRENCIES } from '../catalog.js'
import { post, expand, legs, sys } from '../ledger.js'
import { fail, newId, convert, fmt, mask, money } from '../core.js'
import { walletOf, rowsBlock, partyById, userById } from '../context.js'
import { notify, createLink, shareFor, startCollection, startPayout, collectionHandlers, payoutHandlers } from '../rails.js'
import { amountField, phoneField, textField, regionOfPhone, destinationOf, assertCorridor, deliver, recordPayment, settleRecorded, onRecordedConfirmed, onRecordedRejected, returnCollection } from './shared.js'

const ACTIVE = ['requested', 'claimed', 'held', 'disputed']
// Other modules react to escrow events (a job stage becomes funded, an order becomes paid...).
export const escrowHooks = { stage: {}, order: {} }
const hook = async (client, e, event) => {
  if (e.stage_id) await escrowHooks.stage[event]?.(client, e)
  if (e.order_id) await escrowHooks.order[event]?.(client, e)
}

export const loadEscrow = async (client, id) => one(client, 'SELECT * FROM escrows WHERE id=$1', [id])

// Checks the caller's side of an escrow and its current state.
export async function escrowFor(ctx, id, { role, status }) {
  const e = await loadEscrow(ctx.client, id)
  if (!e || (e.payer_party !== ctx.party.id && e.payee_party !== ctx.party.id)) fail('Introuvable', 404)
  if (role && e[`${role}_party`] !== ctx.party.id) fail('Action non autorisée', 403)
  if (status && ![status].flat().includes(e.status)) fail('Cette action n’est plus possible', 409)
  return e
}

// Whether the payer can put money in escrow through the partner (held) or will pay directly (recorded).
export function modeFor(payerParty, payerUser) {
  const region = payerUser?.region ?? regionOfPhone(payerParty.phone)
  return region && REGIONS[region].custody === 'held' ? 'held' : 'recorded'
}

export async function createRequest(client, { payee, payer, amount, currency, title, mode, stageId = null, orderId = null, notifyPayer = true }) {
  const id = newId()
  await client.query(`INSERT INTO escrows (id, payer_party, payee_party, currency, amount, title, status, mode, stage_id, order_id) VALUES ($1,$2,$3,$4,$5,$6,'requested',$7,$8,$9)`,
    [id, payer.id, payee.id, currency, amount, title, mode, stageId, orderId])
  const url = await createLink(client, { kind: 'escrow', refId: id, partyId: payer.id })
  const text = mode === 'held'
    ? `${mask(payee.name)} vous demande ${fmt(amount, CURRENCIES[currency])} pour « ${title} ». L’argent reste bloqué et n’est versé qu’avec votre accord :`
    : `${mask(payee.name)} vous demande ${fmt(amount, CURRENCIES[currency])} pour « ${title} ». Payez-le directement, puis signalez-le ici :`
  if (notifyPayer) await notify(client, { partyId: payer.id, template: 'escrow.request', text, link: url })
  return { id, url, share: shareFor(text, url) }
}

const escrowAccount = (client, currency) => sys(client, 'escrow', currency)

async function markHeld(client, e, paidCurrency, paidAmount) {
  const updated = await transition(client, 'escrows', e.id, 'requested', 'held', { paid_currency: paidCurrency, paid_amount: paidAmount })
  await notify(client, { partyId: e.payee_party, template: 'escrow.held', text: `${fmt(e.amount, CURRENCIES[e.currency])} sont bloqués pour vous : « ${e.title} ». Ils vous seront versés à la validation.` })
  await hook(client, updated, 'funded')
  return updated
}

// Payer with an account funds from their wallet. Amount debited is in the payer's currency, rounded up.
export async function fundPlan(ctx, e) {
  const payee = await partyById(ctx.client, e.payee_party)
  const dest = await destinationOf(ctx.client, payee)
  if (dest.region !== ctx.user.region) assertCorridor(ctx, dest.region, 'escrow')
  const paid = convert(e.amount, e.currency, ctx.cur.code, 'up')
  return {
    review: { lines: [['Pour', mask(payee.name)], ['Objet', e.title], [`${mask(payee.name)} recevra`, money(e.amount, e.currency)], ['Bloqué sur votre compte', ctx.f(paid), true]], cta: `Bloquer ${ctx.f(paid)}` },
    async exec() {
      await post(ctx.client, { kind: 'escrow_hold', lines: await expand(ctx.client, [legs(await ctx.wallet(), await escrowAccount(ctx.client, e.currency), paid, e.amount,
        { from: { title: 'Fonds bloqués', cpParty: payee.id, icon: 'shield-check', ref: `escrow:${e.id}` } })]) })
      await markHeld(ctx.client, e, ctx.cur.code, paid)
      return { message: `${ctx.f(paid)} bloqués pour ${mask(payee.name)}` }
    },
  }
}

// Payer without an account pays from their own mobile money via a link; funds are held once the partner confirms.
export async function fundByCollection(client, e, phone) {
  if (e.mode !== 'held' || e.status !== 'requested') fail('Cette action n’est plus possible', 409)
  const region = regionOfPhone(phone)
  if (!region || REGIONS[region].custody !== 'held') fail('Le paiement mobile money n’est pas encore ouvert pour ce numéro')
  const currency = REGIONS[region].currency.code
  const amount = convert(e.amount, e.currency, currency, 'up')
  const opId = await startCollection(client, { amount, currency, phone, partyId: e.payer_party, purpose: { type: 'escrow_fund', escrowId: e.id } })
  return { opId, amount, currency }
}
collectionHandlers.escrow_fund = async (client, op) => {
  const e = await one(client, 'SELECT * FROM escrows WHERE id=$1 FOR UPDATE', [op.purpose.escrowId])
  if (e.status !== 'requested') return returnCollection(client, op, e.title)
  await post(client, { kind: 'escrow_hold', idem: `fund:${op.id}`, lines: await expand(client, [legs(await sys(client, 'rail', op.currency), await escrowAccount(client, e.currency), op.amount, e.amount)]) })
  await markHeld(client, e, op.currency, op.amount)
}

payoutHandlers.failed.escrow_release = async (client, op, source) => {
  const e = await one(client, 'SELECT * FROM escrows WHERE id=$1 FOR UPDATE', [op.purpose.escrowId])
  const escrowAcc = await escrowAccount(client, e.currency)
  if (source.id !== escrowAcc.id) await post(client, { kind: 'payout_reversed', idem: `refx:${op.id}`, lines: await expand(client, [legs(source, escrowAcc, op.amount, e.amount)]) })
  await transition(client, 'escrows', e.id, 'released', 'held', { release_to: null, auto_release_at: null })
  if (e.stage_id) await client.query(`UPDATE job_stages SET status='done' WHERE id=$1 AND status='paid'`, [e.stage_id])
  if (e.order_id) await client.query(`UPDATE orders SET status='delivered' WHERE id=$1 AND status='completed'`, [e.order_id])
  for (const pid of [e.payer_party, e.payee_party]) await notify(client, { partyId: pid, template: 'escrow.payout_failed', text: `Le versement pour « ${e.title} » a échoué (numéro mobile money refusé). Les fonds sont de nouveau bloqués ; vérifiez le numéro du bénéficiaire.` })
}

export async function releaseEscrow(client, e, reason = 'Fonds libérés') {
  const payee = await partyById(client, e.payee_party)
  const updated = await transition(client, 'escrows', e.id, ['held', 'disputed'], 'released')
  const r = await deliver(client, { source: await escrowAccount(client, e.currency), amount: e.amount, toParty: payee, title: `${reason} : ${e.title}`, purpose: { type: 'escrow_release', escrowId: e.id, amount: e.amount, currency: e.currency }, kind: 'escrow_release' })
  await client.query('UPDATE escrows SET release_to=$2 WHERE id=$1', [e.id, r.via])
  await notify(client, { partyId: payee.id, template: 'escrow.released', text: `${fmt(r.received, CURRENCIES[r.currency])} vous ont été versés pour « ${e.title} »${r.via === 'payout' ? ' sur votre mobile money' : ''}.` })
  await hook(client, updated, 'released')
  return r
}

// Returns exactly what the payer paid, to where it came from.
export async function refundEscrow(client, e, amount = e.amount) {
  const payer = await partyById(client, e.payer_party)
  const paidBack = amount === e.amount ? e.paid_amount : convert(amount, e.currency, e.paid_currency, 'down')
  const payerUser = payer.user_id ? await userById(client, payer.user_id) : null
  if (payerUser && REGIONS[payerUser.region].custody === 'held' && REGIONS[payerUser.region].currency.code === e.paid_currency) {
    await post(client, { kind: 'escrow_refund', lines: await expand(client, [legs(await escrowAccount(client, e.currency), await walletOf(client, payerUser), amount, paidBack,
      { to: { title: `Fonds remboursés : ${e.title}`, icon: 'rotate-ccw', ref: `escrow:${e.id}` } })]) })
  } else {
    const out = await sys(client, 'fx_out', e.paid_currency)
    await post(client, { kind: 'escrow_refund', lines: await expand(client, [legs(await escrowAccount(client, e.currency), out, amount, paidBack)]) })
    await startPayout(client, { source: out, amount: paidBack, phone: payer.phone, partyId: payer.id, title: `Remboursement : ${e.title}`, purpose: { escrowId: e.id } })
  }
  await notify(client, { partyId: payer.id, template: 'escrow.refunded', text: `${money(paidBack, e.paid_currency)} vous ont été remboursés pour « ${e.title} ».` })
}

export async function openDispute(client, e, party, reason) {
  if (e.status !== 'held') fail('Un litige ne peut être ouvert que sur des fonds bloqués', 409)
  const updated = await transition(client, 'escrows', e.id, 'held', 'disputed', { auto_release_at: null })
  await client.query(`INSERT INTO disputes (id, escrow_id, opened_by, reason, status) VALUES ($1,$2,$3,$4,'open')`, [newId(), e.id, party.id, reason])
  const other = party.id === e.payer_party ? e.payee_party : e.payer_party
  await notify(client, { partyId: other, template: 'dispute.opened', text: `Un litige a été ouvert sur « ${e.title} ». Les fonds restent bloqués ; notre équipe vous contactera sous 48 h.` })
  await hook(client, updated, 'disputed')
}

onRecordedRejected.escrow = async (client, id) => {
  const e = await one(client, 'SELECT * FROM escrows WHERE id=$1', [id])
  if (e?.status !== 'claimed') return
  await transition(client, 'escrows', id, 'claimed', 'requested')
  if (e.stage_id) await client.query(`UPDATE job_stages SET status='validated' WHERE id=$1 AND status='claimed'`, [e.stage_id])
}

onRecordedConfirmed.escrow = async (client, id) => {
  const e = await transition(client, 'escrows', id, ['requested', 'claimed'], 'paid')
  await hook(client, e, 'paid')
}

async function row(ctx, e) {
  const payer = e.payer_party === ctx.party.id
  const other = await partyById(ctx.client, payer ? e.payee_party : e.payer_party)
  const held = e.mode === 'held'
  const map = {
    requested: payer ? [held ? 'À financer' : 'À payer', 'wait', held ? [{ id: 'fund', label: 'Bloquer les fonds', tone: 'primary' }, { id: 'cancel', label: 'Refuser' }] : [{ id: 'claimPaid', label: 'J’ai payé', tone: 'primary' }, { id: 'cancel', label: 'Refuser' }]]
      : ['Demandé', 'wait', held ? [{ id: 'cancel', label: 'Annuler' }, { id: 'share', label: 'Renvoyer le lien' }] : [{ id: 'markReceived', label: 'Paiement reçu', tone: 'primary' }, { id: 'share', label: 'Renvoyer le lien' }]],
    claimed: payer ? ['Paiement signalé', 'wait', []] : ['À confirmer', 'wait', [{ id: 'markReceived', label: 'Confirmer la réception', tone: 'primary' }]],
    held: payer ? ['Bloqué', 'ok', [{ id: 'release', label: 'Libérer', tone: 'primary' }, { id: 'dispute', label: 'Litige' }]] : ['Bloqué pour vous', 'ok', [{ id: 'refund', label: 'Rembourser' }, { id: 'dispute', label: 'Litige' }]],
    disputed: ['Litige en cours', 'bad', []], released: ['Libéré', 'ok', []], paid: ['Payé et confirmé', 'ok', []], refunded: ['Remboursé', '', []], cancelled: ['Annulé', '', []],
  }
  const [status, tone, actions] = map[e.status]
  const auto = e.auto_release_at && e.status === 'held' ? ` · versement automatique le ${new Date(e.auto_release_at).toLocaleDateString('fr-FR')}` : ''
  return { id: e.id, title: e.title, sub: `${payer ? 'Pour' : 'De'} ${mask(other.name)}${held ? '' : ' · payé en direct'}${auto}`, value: money(e.amount, e.currency), status, tone, actions }
}
const mine = ctx => all(ctx.client, 'SELECT * FROM escrows WHERE (payer_party=$1 OR payee_party=$1) AND stage_id IS NULL AND order_id IS NULL ORDER BY created_at DESC', [ctx.party.id])

const simple = (label, opts, effect, message) => ({
  label, form: () => ({ title: label, fields: [] }),
  async run(ctx, input, rowId) { const e = await escrowFor(ctx, rowId, opts); return { message, ...(await effect(ctx, e, input)) } },
})

export default {
  async view(ctx) {
    const list = await mine(ctx)
    const rows = async f => Promise.all(list.filter(f).map(e => row(ctx, e)))
    return {
      blocks: [
        rowsBlock('En cours', 'shield-check', await rows(e => ACTIVE.includes(e.status)), 'Aucun acompte en cours.'),
        rowsBlock('Terminés', 'shield-check', (await rows(e => !ACTIVE.includes(e.status))).slice(0, 10)),
      ],
      actions: ['request', 'hold'],
    }
  },
  widgets: { rows: async ctx => rowsBlock(null, 'shield-check', await Promise.all((await mine(ctx)).filter(e => ACTIVE.includes(e.status)).slice(0, 3).map(e => row(ctx, e)))) },
  async insight(ctx) {
    const e = (await mine(ctx)).find(e => e.status === 'requested' && e.payer_party === ctx.party.id)
    if (!e) return null
    const payee = await partyById(ctx.client, e.payee_party)
    return { icon: 'shield-check', text: `${mask(payee.name)} demande ${money(e.amount, e.currency)} pour « ${e.title} ».`, cta: { label: e.mode === 'held' ? 'Bloquer les fonds' : 'Voir', module: 'escrow', ...(e.mode === 'held' ? { action: 'fund', row: e.id } : {}) } }
  },
  actions: {
    request: {
      label: 'Demander un acompte', icon: 'shield-check',
      form: () => ({ title: 'Demander un acompte', info: 'Le client reçoit un lien. Avec un partenaire de paiement, l’argent est bloqué et vous est versé à sa validation ; sinon il vous paie directement et vous confirmez la réception.', fields: [
        amountField('Montant demandé'), phoneField('Numéro du client'), textField('name', 'Nom du client', { required: false }), textField('title', 'Objet')] }),
      async run(ctx, input) {
        const payer = await ctx.findParty(input.phone, input.name)
        const payerUser = payer.user_id ? await userById(ctx.client, payer.user_id) : null
        const payerRegion = payerUser?.region ?? regionOfPhone(payer.phone)
        if (!payerRegion) fail('Pays du client non pris en charge')
        let mode = modeFor(payer, payerUser)
        if (payerRegion !== ctx.user.region && !(REGIONS[payerRegion].corridors.includes(ctx.user.region) && mode === 'held')) fail(`Les acomptes depuis ${REGIONS[payerRegion].name} ne sont pas ouverts`)
        if (payerRegion === ctx.user.region && !ctx.held) mode = 'recorded'
        const r = await createRequest(ctx.client, { payee: ctx.party, payer, amount: input.amount, currency: ctx.cur.code, title: input.title, mode })
        return { message: `Demande envoyée à ${mask(payer.name)}`, share: r.share }
      },
    },
    hold: {
      label: 'Bloquer des fonds', icon: 'shield-check', custody: 'held',
      form: () => ({ title: 'Bloquer des fonds', info: 'L’argent reste bloqué jusqu’à ce que vous le libériez. Le bénéficiaire n’a pas besoin de l’application.', fields: [
        amountField('Montant à bloquer'), phoneField('Numéro du bénéficiaire'), textField('name', 'Nom du bénéficiaire', { required: false }), textField('title', 'Objet')] }),
      async plan(ctx, input) {
        const payee = await ctx.findParty(input.phone, input.name)
        const dest = await destinationOf(ctx.client, payee)
        assertCorridor(ctx, dest.region, 'escrow')
        const amount = convert(input.amount, ctx.cur.code, dest.currency, 'down')
        if (amount <= 0) fail('Montant trop faible')
        const paid = convert(amount, dest.currency, ctx.cur.code, 'up')
        return {
          review: { lines: [['Pour', mask(payee.name)], ['Objet', input.title], [`${mask(payee.name)} recevra`, money(amount, dest.currency)], ['Bloqué sur votre compte', ctx.f(paid), true]], cta: `Bloquer ${ctx.f(paid)}` },
          async exec() {
            const { id } = await createRequest(ctx.client, { payee, payer: ctx.party, amount, currency: dest.currency, title: input.title, mode: 'held', notifyPayer: false })
            await (await fundPlan(ctx, await loadEscrow(ctx.client, id))).exec()
            return { message: `${ctx.f(paid)} bloqués pour ${mask(payee.name)}` }
          },
        }
      },
    },
    fund: { label: 'Bloquer les fonds', custody: 'held', form: () => ({ title: 'Bloquer les fonds', fields: [] }), plan: async (ctx, input, id) => fundPlan(ctx, await escrowFor(ctx, id, { role: 'payer', status: 'requested' })) },
    release: {
      label: 'Libérer', form: () => ({ title: 'Libérer les fonds', fields: [] }),
      async plan(ctx, input, id) {
        const e = await escrowFor(ctx, id, { role: 'payer', status: 'held' })
        const payee = await partyById(ctx.client, e.payee_party)
        return {
          review: { lines: [['Bénéficiaire', mask(payee.name)], ['Objet', e.title], ['Montant versé', money(e.amount, e.currency), true]], cta: `Libérer ${money(e.amount, e.currency)}` },
          async exec() { await releaseEscrow(ctx.client, e); return { message: `${money(e.amount, e.currency)} versés à ${mask(payee.name)}` } },
        }
      },
    },
    refund: {
      label: 'Rembourser', form: () => ({ title: 'Rembourser le client', fields: [] }),
      async plan(ctx, input, id) {
        const e = await escrowFor(ctx, id, { role: 'payee', status: 'held' })
        const payer = await partyById(ctx.client, e.payer_party)
        return {
          review: { lines: [['Client remboursé', mask(payer.name)], ['Objet', e.title], ['Montant rendu', money(e.paid_amount, e.paid_currency), true]], cta: `Rembourser ${money(e.paid_amount, e.paid_currency)}` },
          async exec() { await transition(ctx.client, 'escrows', e.id, 'held', 'refunded'); await refundEscrow(ctx.client, e); await hook(ctx.client, e, 'refunded'); return { message: 'Fonds remboursés au client' } },
        }
      },
    },
    cancel: simple('Annuler', { status: 'requested' }, async (ctx, e) => { await transition(ctx.client, 'escrows', e.id, 'requested', 'cancelled'); await hook(ctx.client, e, 'cancelled') }, 'Demande annulée'),
    share: simple('Renvoyer le lien', { role: 'payee', status: ['requested', 'claimed'] }, async (ctx, e) => {
      const url = await createLink(ctx.client, { kind: 'escrow', refId: e.id, partyId: e.payer_party })
      return { share: shareFor(`Rappel : ${money(e.amount, e.currency)} pour « ${e.title} »`, url) }
    }, 'Lien prêt à partager'),
    claimPaid: simple('J’ai payé', { role: 'payer', status: 'requested' }, async (ctx, e) => {
      if (e.mode !== 'recorded') fail('Utilisez « Bloquer les fonds »')
      const payee = await partyById(ctx.client, e.payee_party)
      await recordPayment(ctx, { payerParty: ctx.party, payeeParty: payee, amount: e.amount, currency: e.currency, purpose: e.title, ref: `escrow:${e.id}` })
      await transition(ctx.client, 'escrows', e.id, 'requested', 'claimed')
    }, 'Paiement signalé. Le bénéficiaire doit confirmer.'),
    markReceived: simple('Paiement reçu', { role: 'payee', status: ['requested', 'claimed'] }, async (ctx, e) => {
      if (e.mode !== 'recorded') fail('Ces fonds passent par le partenaire de paiement')
      const pending = await one(ctx.client, `SELECT id FROM recorded_payments WHERE ref=$1 AND status='claimed'`, [`escrow:${e.id}`])
      if (pending) { await settleRecorded(ctx.client, pending.id, ctx.party, true); return {} }
      await ctx.client.query(`INSERT INTO recorded_payments (id, payer_party, payee_party, amount, currency, purpose, ref, recorded_by, status, confirmed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$3,'confirmed', now())`,
        [newId(), e.payer_party, e.payee_party, e.amount, e.currency, e.title, `escrow:${e.id}`])
      const updated = await transition(ctx.client, 'escrows', e.id, 'requested', 'paid')
      await hook(ctx.client, updated, 'paid')
    }, 'Réception confirmée'),
    dispute: {
      label: 'Litige', form: () => ({ title: 'Signaler un litige', info: 'Les fonds restent bloqués. Notre équipe examine les preuves des deux côtés et décide sous 5 jours ouvrés.', fields: [textField('reason', 'Que s’est-il passé ?', { max: 300 })] }),
      async run(ctx, input, id) { await openDispute(ctx.client, await escrowFor(ctx, id, { status: 'held' }), ctx.party, input.reason); return { message: 'Litige ouvert. Les fonds restent bloqués.' } },
    },
  },
  kept: async (client, partyId) => (await one(client, `SELECT count(*)::int AS n FROM escrows WHERE payee_party=$1 AND status IN ('released','paid')`, [partyId])).n,
}

export const autoReleaseDue = client => all(client, `SELECT * FROM escrows WHERE status='held' AND auto_release_at IS NOT NULL AND auto_release_at <= now() LIMIT 50`)
export const autoReleaseDays = () => config.autoReleaseDays
