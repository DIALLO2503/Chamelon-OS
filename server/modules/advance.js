// Advance on earnings ("Avance sur revenus"): part of what the person has already been earning, paid now, repaid from their wallet.
// Funded by a licensed lender's credit line held at the payment partner (system account "lender"); Nexus decides eligibility from
// money that actually reached the wallet, never from self-declared logs, and charges one flat fee shown upfront: no interest,
// no late fees, no rollover. One advance at a time. held custody only: in record custody no money passes through Nexus.
import { pool, tx, one, all } from '../db.js'
import { config } from '../config.js'
import { PRICING } from '../catalog.js'
import { post, sys, balanceOf } from '../ledger.js'
import { fail, newId, longDate, money } from '../core.js'
import { walletOf, rowsBlock, userById } from '../context.js'
import { notify } from '../rails.js'
import { log } from '../log.js'
import { amountField } from './shared.js'

const DAY = 86400000
// Entry kinds that are not earnings: the person's own top-ups, advances, refunds and returns of their own money.
const NOT_EARNINGS = ['topup', 'advance', 'payout_reversed', 'escrow_refund', 'order_refund', 'adjustment', 'tontine_out', 'collection_return']

const terms = ctx => {
  const p = PRICING.advance, code = ctx.cur.code
  return { share: p.share, cap: p.cap[code], fee: p.fee[code], termDays: p.termDays, minAgeDays: p.minAgeDays, minEarningDays: p.minEarningDays }
}
// In live, the module stays closed until a lender is configured (ADVANCE_LENDER); the sandbox simulates one.
const lenderReady = () => config.sandbox || Boolean(config.advances.lender)

export const activeAdvance = (client, userId) => one(client, `SELECT * FROM advances WHERE user_id=$1 AND status='active'`, [userId])
const owed = a => a.amount + a.fee - a.repaid

// What the person may borrow now, and why not when they may not.
export async function eligibility(ctx) {
  const t = terms(ctx)
  if (!ctx.held || t.cap === undefined) return { ok: false, reason: 'Les avances ne sont pas proposées dans votre pays pour le moment.' }
  if (!lenderReady()) return { ok: false, reason: 'Les avances ouvriront dès que notre partenaire de crédit agréé sera raccordé.' }
  if (ctx.user.kyc_level < 1) return { ok: false, reason: 'Vérifiez votre identité pour demander une avance.' }
  if (await activeAdvance(ctx.client, ctx.user.id)) return { ok: false, reason: 'Remboursez votre avance en cours avant d’en demander une autre.' }
  const age = Math.floor((Date.now() - new Date(ctx.user.created_at).getTime()) / DAY)
  if (age < t.minAgeDays) return { ok: false, reason: `Les avances sont ouvertes après ${t.minAgeDays} jours d’activité (encore ${t.minAgeDays - age}).` }
  const e = await one(ctx.client, `SELECT COALESCE(SUM(p.amount),0)::bigint AS total, count(DISTINCT p.created_at::date)::int AS days
    FROM postings p JOIN entries e ON e.id=p.entry_id
    WHERE p.account_id=$1 AND p.amount > 0 AND e.kind <> ALL($2) AND p.created_at > now() - interval '90 days'`, [(await ctx.wallet()).id, NOT_EARNINGS])
  if (e.days < t.minEarningDays) return { ok: false, reason: `Il faut au moins ${t.minEarningDays} jours de revenus reçus sur Nexus ces 3 derniers mois (vous en avez ${e.days}).` }
  const monthly = Math.floor(e.total / 3)
  const max = Math.min(t.cap, Math.floor(monthly * t.share))
  if (max <= t.fee) return { ok: false, reason: 'Vos revenus reçus sur Nexus sont encore trop faibles pour une avance.' }
  return { ok: true, max, monthly, fee: t.fee, termDays: t.termDays }
}

// Moves up to `want` from the wallet to the lender. Repayment is never blocked by spending limits (ledger: OUTFLOW_EXEMPT).
async function repay(client, advance, user, want) {
  const wallet = await walletOf(client, user)
  const pay = Math.min(want, owed(advance), await balanceOf(client, wallet.id))
  if (pay <= 0) return 0
  await post(client, { kind: 'advance_repay', lines: [
    { account: wallet, amount: -pay, title: 'Remboursement d’avance', icon: 'hand-coins', ref: `advance:${advance.id}` },
    { account: await sys(client, 'lender', advance.currency), amount: pay, ref: `advance:${advance.id}` }] })
  const done = advance.repaid + pay >= advance.amount + advance.fee
  await client.query(`UPDATE advances SET repaid=repaid+$2, status=$3, repaid_at=$4 WHERE id=$1`, [advance.id, pay, done ? 'repaid' : 'active', done ? new Date() : null])
  return pay
}

// Scheduler: on the due date, take what the wallet holds; keep collecting daily afterwards, reminding once a day. Never a late fee.
export async function collectDueAdvances() {
  const due = await all(pool, `SELECT id FROM advances WHERE status='active' AND due_at <= now()`)
  for (const { id } of due) {
    try {
      await tx(async c => {
        const a = await one(c, `SELECT * FROM advances WHERE id=$1 AND status='active' FOR UPDATE`, [id])
        if (!a) return
        const user = await userById(c, a.user_id)
        const paid = await repay(c, a, user, owed(a))
        const left = owed(a) - paid
        if (left > 0) await notify(c, { userId: user.id, template: 'advance.due', text: `Avance : ${paid ? `${money(paid, a.currency)} prélevés, ` : ''}${money(left, a.currency)} restent à rembourser. Le prélèvement se fera automatiquement dès que de l’argent arrivera sur votre compte. Pas de pénalité de retard.`, dedupe: `advance-due:${a.id}:${new Date().toISOString().slice(0, 10)}` })
        else await notify(c, { userId: user.id, template: 'advance.repaid', text: 'Votre avance est entièrement remboursée. Merci !', dedupe: `advance-repaid:${a.id}` })
      })
    } catch (err) { log.error({ err, advance: id }, 'advance collection failed') }
  }
}

export default {
  async view(ctx) {
    const a = await activeAdvance(ctx.client, ctx.user.id)
    const history = (await all(ctx.client, 'SELECT * FROM advances WHERE user_id=$1 ORDER BY created_at DESC LIMIT 12', [ctx.user.id])).map(x => ({
      id: x.id, title: `Avance de ${ctx.f(x.amount)}`, sub: x.status === 'repaid' ? `Remboursée le ${longDate(x.repaid_at)}` : `À rembourser avant le ${longDate(x.due_at)}`,
      value: ctx.f(x.amount + x.fee), status: x.status === 'repaid' ? 'Remboursée' : 'En cours', tone: x.status === 'repaid' ? 'ok' : 'wait',
      progress: x.status === 'active' ? x.repaid / (x.amount + x.fee) : undefined,
    }))
    const el = a ? null : await eligibility(ctx)
    const t = terms(ctx)
    const head = a
      ? { type: 'goal', title: 'Avance en cours', main: `${ctx.f(owed(a))} à rembourser`, detail: `${ctx.f(a.repaid)} remboursés sur ${ctx.f(a.amount + a.fee)} · échéance le ${longDate(a.due_at)}`, pct: a.repaid / (a.amount + a.fee) }
      : el.ok
        ? { type: 'goal', title: 'Disponible maintenant', main: `Jusqu’à ${ctx.f(el.max)}`, detail: `Calculé sur vos revenus reçus (${ctx.f(el.monthly)} par mois en moyenne) · frais fixes ${ctx.f(el.fee)}`, pct: 1, reached: true }
        : { type: 'note', title: 'Avance indisponible', text: el.reason }
    return {
      blocks: [head, rowsBlock('Historique', 'hand-coins', history),
        { type: 'note', title: 'Les règles', text: `Jusqu’à ${Math.round(t.share * 100)} % de vos revenus mensuels reçus sur Nexus${t.cap !== undefined ? `, ${ctx.f(t.cap)} au plus` : ''}. Frais fixes de ${t.fee !== undefined ? ctx.f(t.fee) : '—'} par avance, annoncés avant de confirmer : pas d’intérêts, pas de pénalités de retard. Remboursement automatique à ${t.termDays} jours depuis votre solde, ou avant quand vous voulez. Une avance à la fois.${config.sandbox ? ' Bac à sable : le prêteur est simulé.' : ''}` }],
      actions: a ? ['repay'] : ['draw'],
    }
  },
  async insight(ctx) {
    const a = await activeAdvance(ctx.client, ctx.user.id)
    if (!a || new Date(a.due_at).getTime() - Date.now() > 3 * DAY) return null
    return { icon: 'hand-coins', text: `Votre avance (${ctx.f(owed(a))} restants) est due le ${longDate(a.due_at)}. Elle sera prélevée sur votre solde.`, cta: { label: 'Rembourser', module: 'advance', action: 'repay' } }
  },
  actions: {
    draw: {
      label: 'Demander une avance', icon: 'hand-coins', custody: 'held',
      async form(ctx) {
        const el = await eligibility(ctx)
        if (!el.ok) return { title: 'Demander une avance', info: el.reason, fields: [], blocked: true }
        return { title: 'Demander une avance', info: `Jusqu’à ${ctx.f(el.max)}. Frais fixes : ${ctx.f(el.fee)}. Remboursement automatique dans ${el.termDays} jours.`, fields: [amountField('Montant de l’avance')] }
      },
      async plan(ctx, input) {
        const el = await eligibility(ctx)
        if (!el.ok) fail(el.reason, 409)
        if (input.amount > el.max) fail(`Au plus ${ctx.f(el.max)} pour le moment`)
        const due = new Date(Date.now() + el.termDays * DAY)
        return {
          review: { lines: [['Vous recevez', ctx.f(input.amount), true], ['Frais fixes (pas d’intérêts)', ctx.f(el.fee)], ['À rembourser', ctx.f(input.amount + el.fee)], ['Échéance', longDate(due)], ['Remboursement', 'Automatique depuis votre solde, ou avant à tout moment']], cta: `Recevoir ${ctx.f(input.amount)}` },
          async exec() {
            const id = newId()
            // The unique index refuses a second active advance, even from two confirmations racing each other.
            await ctx.client.query('INSERT INTO advances (id, user_id, currency, amount, fee, due_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, ctx.user.id, ctx.cur.code, input.amount, el.fee, due])
            await post(ctx.client, { kind: 'advance', idem: `advance:${id}`, lines: [
              { account: await sys(ctx.client, 'lender', ctx.cur.code), amount: -input.amount, ref: `advance:${id}` },
              { account: await ctx.wallet(), amount: input.amount, title: 'Avance sur revenus', icon: 'hand-coins', ref: `advance:${id}` }] })
            return { message: `${ctx.f(input.amount)} crédités. À rembourser avant le ${longDate(due)} : ${ctx.f(input.amount + el.fee)}.` }
          },
        }
      },
    },
    repay: {
      label: 'Rembourser', icon: 'hand-coins', custody: 'held',
      async form(ctx) {
        const a = await activeAdvance(ctx.client, ctx.user.id)
        if (!a) return { title: 'Rembourser', info: 'Aucune avance en cours.', fields: [], blocked: true }
        return { title: 'Rembourser mon avance', info: `Reste à rembourser : ${ctx.f(owed(a))}. Pris sur votre solde Nexus.`, fields: [amountField('Montant', { hint: `Au plus ${ctx.f(owed(a))}` })] }
      },
      async plan(ctx, input) {
        const a = await activeAdvance(ctx.client, ctx.user.id)
        if (!a) fail('Aucune avance en cours', 409)
        const pay = Math.min(input.amount, owed(a))
        return {
          review: { lines: [['Remboursement', ctx.f(pay), true], ['Reste ensuite', ctx.f(owed(a) - pay)]], cta: `Rembourser ${ctx.f(pay)}` },
          async exec() {
            const fresh = await one(ctx.client, `SELECT * FROM advances WHERE id=$1 AND status='active' FOR UPDATE`, [a.id])
            if (!fresh) fail('Cette avance est déjà remboursée', 409)
            const wallet = await ctx.wallet()
            if (await balanceOf(ctx.client, wallet.id) < pay) fail('Solde insuffisant')
            const paid = await repay(ctx.client, fresh, ctx.user, pay)
            return { message: owed(fresh) - paid <= 0 ? 'Avance entièrement remboursée. Merci !' : `${ctx.f(paid)} remboursés. Reste ${ctx.f(owed(fresh) - paid)}.` }
          },
        }
      },
    },
  },
}

export { terms as advanceTerms }
