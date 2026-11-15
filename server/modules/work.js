import { pool, tx, one, all, transition } from '../db.js'
import { config } from '../config.js'
import { PRICING, FX_E8_PER_EUR } from '../catalog.js'
import { post, expand, legs, sys, balanceOf } from '../ledger.js'
import { fail, newId, today, ago, mask, sha256, convert } from '../core.js'
import { walletOf, balanceBlock, rowsBlock, userById, ctxFor } from '../context.js'
import { notify } from '../rails.js'
import { log } from '../log.js'
import { amountField, phoneField, textField } from './shared.js'
import tontine from './tontine.js'
import { computeBadges } from '../trust.js'
import escrow from './escrow.js'

const dayOffset = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

/* ---------------- shifts: a driver's own log of fares and costs ---------------- */
const netOn = async (ctx, date) => (await one(ctx.client, `SELECT COALESCE(SUM(CASE kind WHEN 'trip' THEN amount ELSE -amount END),0)::bigint AS net FROM shift_items WHERE user_id=$1 AND created_at::date=$2`, [ctx.user.id, date])).net
const logItem = (kind, title, labelField) => ({
  label: title, icon: kind === 'trip' ? 'car' : 'fuel',
  form: () => ({ title, fields: [amountField(), textField('label', labelField, { required: false })] }),
  async run(ctx, input) {
    await ctx.client.query('INSERT INTO shift_items (id, user_id, kind, label, amount) VALUES ($1,$2,$3,$4,$5)', [newId(), ctx.user.id, kind, input.label || (kind === 'trip' ? 'Course' : 'Carburant'), input.amount])
    return { message: `${title} de ${ctx.f(input.amount)} notée` }
  },
})

export const shifts = {
  async view(ctx) {
    const items = (await all(ctx.client, 'SELECT * FROM shift_items WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [ctx.user.id]))
      .map(i => ({ id: i.id, title: i.label, sub: ago(i.created_at), value: (i.kind === 'trip' ? '+' : '−') + ctx.f(i.amount), icon: i.kind === 'trip' ? 'car' : 'fuel' }))
    return { blocks: [await shifts.widgets.kpis(ctx), await shifts.widgets.bars(ctx), rowsBlock('Dernières entrées', 'car', items, 'Notez votre première course.')], actions: ['trip', 'expense'] }
  },
  widgets: {
    async kpis(ctx) {
      const k = await one(ctx.client, `SELECT count(*) FILTER (WHERE kind='trip')::int AS trips, COALESCE(SUM(amount) FILTER (WHERE kind='trip'),0)::bigint AS gross,
        COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0)::bigint AS costs FROM shift_items WHERE user_id=$1 AND created_at::date = CURRENT_DATE`, [ctx.user.id])
      return { type: 'kpis', title: "Aujourd'hui", items: [{ label: 'Courses', value: String(k.trips) }, { label: 'Recette', value: ctx.f(k.gross) }, { label: 'Dépenses', value: ctx.f(k.costs), tone: k.costs ? 'bad' : '' }, { label: 'Net du jour', value: ctx.f(k.gross - k.costs), tone: 'ok' }] }
    },
    async bars(ctx) {
      const days = []
      for (const n of [6, 5, 4, 3, 2, 1, 0]) { const date = dayOffset(n); days.push({ label: new Intl.DateTimeFormat('fr-FR', { weekday: 'short' }).format(new Date(date)).slice(0, 3), value: Math.max(0, await netOn(ctx, date)) }) }
      return { type: 'bars', title: '7 derniers jours', bars: days, caption: 'Net sur 7 jours', total: ctx.f(days.reduce((s, d) => s + d.value, 0)) }
    },
  },
  actions: { trip: logItem('trip', 'Course', 'Trajet (facultatif)'), expense: logItem('expense', 'Dépense', 'Nature (carburant, lavage…)') },
}

/* ---------------- budget: a monthly envelope and the user's own expense log ---------------- */
const CATEGORIES = ['Loyer', 'Courses', 'Transport', 'Loisirs', 'Autre']
export const budget = {
  async view(ctx) {
    const items = (await all(ctx.client, 'SELECT * FROM expenses WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [ctx.user.id])).map(e => ({ id: e.id, title: e.label || e.category, sub: `${e.category} · ${ago(e.created_at).toLowerCase()}`, value: ctx.f(e.amount) }))
    return { blocks: [await budget.widgets.budget(ctx) ?? { type: 'note', title: 'Pas encore de budget', text: 'Fixez un montant pour le mois et suivez ce qu’il vous reste.' }, rowsBlock('Dépenses', 'minus', items)], actions: ['expense', 'set'] }
  },
  widgets: {
    async budget(ctx) {
      const b = await one(ctx.client, 'SELECT total FROM budgets WHERE user_id=$1', [ctx.user.id]); if (!b) return null
      const cats = await all(ctx.client, `SELECT category, SUM(amount)::bigint AS spent FROM expenses WHERE user_id=$1 AND created_at >= date_trunc('month', now()) GROUP BY category ORDER BY spent DESC`, [ctx.user.id])
      const spent = cats.reduce((s, c) => s + c.spent, 0)
      return { type: 'budget', title: 'Budget du mois', left: ctx.f(Math.max(0, b.total - spent)), detail: `${ctx.f(spent)} dépensés sur ${ctx.f(b.total)}`, pct: Math.min(1, spent / b.total), over: spent > b.total, cats: cats.map(c => ({ label: c.category, value: ctx.f(c.spent) })) }
    },
  },
  actions: {
    set: {
      label: 'Fixer le budget', icon: 'piggy-bank', form: () => ({ title: 'Budget du mois', fields: [amountField('Budget mensuel')] }),
      async run(ctx, input) { await ctx.client.query('INSERT INTO budgets (user_id, total) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET total=EXCLUDED.total', [ctx.user.id, input.amount]); return { message: `Budget fixé à ${ctx.f(input.amount)}` } },
    },
    expense: {
      label: 'Dépense', icon: 'minus',
      form: () => ({ title: 'Noter une dépense', fields: [amountField(), { name: 'category', label: 'Catégorie', type: 'select', options: CATEGORIES.map(c => ({ value: c, label: c })) }, textField('label', 'Détail (facultatif)', { required: false })] }),
      async run(ctx, input) { await ctx.client.query('INSERT INTO expenses (id, user_id, category, amount, label) VALUES ($1,$2,$3,$4,$5)', [newId(), ctx.user.id, input.category, input.amount, input.label ?? null]); return { message: `Dépense de ${ctx.f(input.amount)} notée` } },
    },
  },
}

/* ---------------- float: approved agents swap cash for e-money ---------------- */
const commission = amount => Math.round(amount * PRICING.agentCommissionBps / 10000)
const opsToday = ctx => one(ctx.client, `SELECT count(*)::int AS n, COALESCE(SUM(amount),0)::bigint AS volume,
  COALESCE(SUM(amount) FILTER (WHERE kind='in'),0)::bigint AS deposits FROM cash_ops WHERE agent_id=$1 AND created_at::date = CURRENT_DATE`, [ctx.user.id])

async function recordOp(ctx, customer, kind, amount) {
  const opId = newId()
  await ctx.client.query('INSERT INTO cash_ops (id, agent_id, customer_id, kind, amount) VALUES ($1,$2,$3,$4,$5)', [opId, ctx.user.id, customer.id, kind, amount])
  await ctx.client.query(`INSERT INTO commission_accruals (id, agent_id, op_id, amount, status) VALUES ($1,$2,$3,$4,'accrued')`, [newId(), ctx.user.id, opId, commission(amount)])
}

export const float = {
  async view(ctx) {
    const ops = (await all(ctx.client, `SELECT c.*, u.name FROM cash_ops c JOIN users u ON u.id=c.customer_id WHERE c.agent_id=$1 ORDER BY c.created_at DESC LIMIT 20`, [ctx.user.id])).map(c => ({
      id: c.id, title: c.kind === 'in' ? 'Dépôt client' : 'Retrait client', sub: `${mask(c.name)} · ${ago(c.created_at).toLowerCase()}`, value: ctx.f(c.amount), icon: c.kind === 'in' ? 'arrow-down-left' : 'arrow-up-right',
      ...(c.flagged ? { status: 'Signalé', tone: 'bad' } : {}) }))
    const c = await one(ctx.client, `SELECT COALESCE(SUM(amount) FILTER (WHERE status='accrued'),0)::bigint AS accrued, COALESCE(SUM(amount) FILTER (WHERE status='paid'),0)::bigint AS paid,
      COALESCE(SUM(amount) FILTER (WHERE status='withheld'),0)::bigint AS withheld FROM commission_accruals WHERE agent_id=$1`, [ctx.user.id])
    return { blocks: [await balanceBlock(ctx, 'Float disponible'), await float.widgets.kpis(ctx),
      { type: 'kpis', title: 'Commissions', items: [{ label: 'À verser', value: ctx.f(c.accrued), tone: 'wait' }, { label: 'Versées', value: ctx.f(c.paid), tone: 'ok' }, { label: 'Retenues', value: ctx.f(c.withheld), tone: c.withheld ? 'bad' : '' }] },
      rowsBlock('Opérations', 'landmark', ops, 'Aucune opération pour le moment.'),
      { type: 'note', title: 'Règles', text: 'Les commissions sont versées chaque jour. Un dépôt et un retrait entre vous et le même client dans la journée ne donnent pas de commission.' }],
      actions: ['cashIn', 'cashOut'] }
  },
  widgets: {
    async kpis(ctx) { const k = await opsToday(ctx); return { type: 'kpis', title: "Aujourd'hui", items: [{ label: 'Opérations', value: String(k.n) }, { label: 'Volume', value: ctx.f(k.volume) }] } },
  },
  async insight(ctx) {
    if (ctx.persona.restricted !== 'agent') return null // float exists region-wide, but only agents run it
    if (!ctx.hasRole('agent')) return { icon: 'clock', text: 'Votre demande d’agrément d’agent est en cours de vérification. Les opérations clients s’activeront après validation.', cta: { label: 'Voir', module: 'float' } }
    const k = await opsToday(ctx), balance = await balanceOf(ctx.client, (await ctx.wallet()).id)
    return k.deposits > balance ? { icon: 'arrow-left-right', text: `Votre float (${ctx.f(balance)}) est inférieur aux dépôts servis aujourd’hui (${ctx.f(k.deposits)}). Pensez à vous réapprovisionner.`, cta: { label: 'Approvisionner', module: 'wallet', action: 'topup' } } : null
  },
  actions: {
    cashIn: {
      label: 'Dépôt client', icon: 'arrow-down-left', custody: 'held', role: 'agent',
      form: () => ({ title: 'Dépôt client', info: 'Le client vous remet des espèces ; son compte est crédité depuis votre float.', fields: [amountField(), phoneField('Numéro du client')] }),
      async plan(ctx, input) {
        const customer = await ctx.findUser(input.phone)
        if (customer.region !== ctx.user.region) fail('Ce client est dans un autre pays')
        const a = input.amount
        return {
          review: { lines: [['Client', mask(customer.name)], ['Espèces à encaisser', ctx.f(a), true], ['Votre commission (versée demain)', ctx.f(commission(a))]], cta: `Créditer ${ctx.f(a)}` },
          async exec() {
            const cp = await one(ctx.client, 'SELECT id FROM parties WHERE user_id=$1', [customer.id])
            await post(ctx.client, { kind: 'cash_in', lines: await expand(ctx.client, [legs(await ctx.wallet(), await walletOf(ctx.client, customer), a, a, {
              from: { title: 'Dépôt client', cpParty: cp.id, icon: 'arrow-up-right' }, to: { title: 'Dépôt en espèces', cpParty: ctx.party.id, icon: 'banknote' } })]) })
            await recordOp(ctx, customer, 'in', a)
            await notify(ctx.client, { userId: customer.id, template: 'cash.in', text: `Dépôt de ${ctx.f(a)} chez l’agent ${mask(ctx.user.name)}.` })
            return { message: `${ctx.f(a)} crédités à ${mask(customer.name)}` }
          },
        }
      },
    },
    cashOut: {
      label: 'Retrait client', icon: 'arrow-up-right', custody: 'held', role: 'agent',
      form: () => ({ title: 'Retrait client', info: 'Le client crée un code de retrait dans son application et vous le montre. Saisissez-le, puis remettez les espèces.', fields: [textField('code', 'Code du client (8 chiffres)', { max: 8 })] }),
      async plan(ctx, input) {
        const code = await one(ctx.client, `SELECT c.*, u.name, u.region FROM cash_codes c JOIN users u ON u.id=c.customer_id WHERE c.code_hash=$1 AND c.used_at IS NULL AND c.expires_at > now()`, [sha256(`${input.code}:${config.linkSecret}`)])
        if (!code) fail('Code inconnu, expiré ou déjà utilisé')
        if (code.region !== ctx.user.region) fail('Ce client est dans un autre pays')
        if (code.customer_id === ctx.user.id) fail('Vous ne pouvez pas retirer chez vous-même')
        return {
          review: { lines: [['Client', mask(code.name)], ['Espèces à remettre', ctx.f(code.amount), true]], cta: `Valider le retrait de ${ctx.f(code.amount)}` },
          async exec() {
            const used = await ctx.client.query('UPDATE cash_codes SET used_at=now(), agent_id=$2 WHERE id=$1 AND used_at IS NULL RETURNING id', [code.id, ctx.user.id])
            if (!used.rowCount) fail('Ce code vient d’être utilisé', 409)
            const customer = await userById(ctx.client, code.customer_id)
            const cp = await one(ctx.client, 'SELECT id FROM parties WHERE user_id=$1', [customer.id])
            await post(ctx.client, { kind: 'cash_out', lines: await expand(ctx.client, [legs(await walletOf(ctx.client, customer), await ctx.wallet(), code.amount, code.amount, {
              from: { title: 'Retrait en espèces', cpParty: ctx.party.id, icon: 'banknote' }, to: { title: 'Retrait client', cpParty: cp.id, icon: 'arrow-down-left' } })]) })
            await recordOp(ctx, customer, 'out', code.amount)
            await notify(ctx.client, { userId: customer.id, template: 'cash.out', text: `Retrait de ${ctx.f(code.amount)} chez l’agent ${mask(ctx.user.name)}.` })
            return { message: `Remettez ${ctx.f(code.amount)} en espèces à ${mask(customer.name)}` }
          },
        }
      },
    },
  },
}

// Daily: pays commissions once they are 24 h old (so a round trip's second leg is always visible), withholding same-day round trips (deposit and withdrawal between one agent and one customer).
export async function settleCommissions() {
  const due = await all(pool, `SELECT a.*, o.customer_id, o.kind, o.created_at AS op_at FROM commission_accruals a JOIN cash_ops o ON o.id=a.op_id
    WHERE a.status='accrued' AND a.created_at < now() - interval '24 hours'`)
  for (const acc of due) {
    try {
      await tx(async c => {
        const roundTrip = await one(c, `SELECT 1 FROM cash_ops WHERE agent_id=$1 AND customer_id=$2 AND kind<>$3 AND abs(extract(epoch FROM created_at - $4::timestamptz)) < 86400`, [acc.agent_id, acc.customer_id, acc.kind, acc.op_at])
        if (roundTrip) {
          await c.query(`UPDATE commission_accruals SET status='withheld' WHERE id=$1 AND status='accrued'`, [acc.id])
          await c.query('UPDATE cash_ops SET flagged=true WHERE id=$1', [acc.op_id])
          return
        }
        const agent = await userById(c, acc.agent_id)
        const claimed = await c.query(`UPDATE commission_accruals SET status='paid' WHERE id=$1 AND status='accrued'`, [acc.id])
        if (!claimed.rowCount || acc.amount <= 0) return
        const wallet = await walletOf(c, agent)
        await post(c, { kind: 'commission', idem: `commission:${acc.id}`, lines: [{ account: await sys(c, 'commissions', wallet.currency), amount: -acc.amount }, { account: wallet, amount: acc.amount, title: 'Commission', icon: 'coins' }] })
      })
    } catch (e) { log.error({ err: e, accrual: acc.id }, 'commission settlement failed') }
  }
}

/* ---------------- reputation: derived from kept commitments with distinct people, visible to the user only ---------------- */
// Levels gate what the app shows (progressive disclosure, engine.js) and lower some prices. Names follow the zellij.
export const LEVELS = [[0, 'Premières pièces'], [150, 'Motif'], [400, 'Rosace'], [700, 'Zellij complet']]
const TILES = 36

export async function computeScore(client, user, party) {
  const pid = party.id
  const age = Math.floor((Date.now() - new Date(user.created_at).getTime()) / 86400000)
  // Distinct people who confirmed a real payment with this user (round trips with one person count once).
  const people = (await one(client, `SELECT count(DISTINCT cp)::int AS n FROM (
      SELECT CASE WHEN payer_party=$1 THEN payee_party ELSE payer_party END AS cp FROM recorded_payments WHERE status='confirmed' AND (payer_party=$1 OR payee_party=$1)
      UNION SELECT CASE WHEN payer_party=$1 THEN payee_party ELSE payer_party END FROM escrows WHERE status IN ('released','paid') AND (payer_party=$1 OR payee_party=$1)
      UNION SELECT d.cp_party FROM postings p JOIN posting_details d ON d.posting_id=p.id JOIN accounts a ON a.id=p.account_id WHERE a.owner=$2 AND a.kind='wallet' AND d.cp_party IS NOT NULL) x`, [pid, user.id])).n
  const contribs = await tontine.contributions(client, pid)
  const late = await tontine.lateFor(client, pid)
  const defaults = await tontine.defaultsFor(client, pid)
  const kept = await escrow.kept(client, pid)
  const confirmed = (await one(client, `SELECT count(*)::int AS n FROM recorded_payments WHERE status='confirmed' AND (payer_party=$1 OR payee_party=$1)`, [pid])).n
  const lost = (await one(client, `SELECT count(*)::int AS n FROM disputes WHERE status='resolved' AND resolution->>'against' = $1`, [pid])).n
  const signals = [
    ['Personnes différentes qui ont confirmé un paiement avec vous', people, 15, 300],
    ['Cotisations versées et confirmées', contribs, 12, 250],
    ['Engagements tenus (acomptes et étapes payés)', kept, 10, 300],
    ['Ancienneté du compte', age, 180, 150],
  ].map(([label, n, cap, weight]) => ({ label, pct: Math.min(1, n / cap), weight }))
  const penalty = late * 40 + defaults * 60 + lost * 120
  const value = Math.max(0, Math.round(signals.reduce((s, x) => s + x.pct * x.weight, 0)) - penalty)
  const level = LEVELS.findLastIndex(([min]) => value >= min)
  // One tile per kept commitment; a person who confirms many payments still fills at most three tiles.
  const tiles = Math.min(TILES, contribs + kept + Math.min(confirmed, people * 3))
  return { value, level, signals, penalty, tiles, people, contribs, late, kept, confirmed, lost }
}
export const levelOf = async ctx => (await computeScore(ctx.client, ctx.user, ctx.party)).level

// Compact version for the home screen: the value, the level and how far the next one is. Opens the full view.
export async function scoreCard(ctx, title, { unlock = null } = {}) {
  const s = await computeScore(ctx.client, ctx.user, ctx.party)
  const [floor, name] = LEVELS[s.level], next = LEVELS[s.level + 1]
  const badges = (await computeBadges(ctx.client, ctx.user, ctx.party, s)).filter(b => b.earned).map(b => ({ icon: b.icon, label: b.label }))
  return {
    type: 'scorecard', title, value: s.value, name, level: s.level + 1,
    pct: next ? (s.value - floor) / (next[0] - floor) : 1,
    next: next ? `Encore ${next[0] - s.value} points pour « ${next[1]} »` : 'Niveau maximum atteint',
    badges, unlock,
    cta: { label: 'Voir le détail', module: 'score' },
  }
}

/* ---------------- reputation: derived from kept commitments with distinct people, visible to the user only ---------------- */
export const score = {
  async view(ctx) {
    const s = await computeScore(ctx.client, ctx.user, ctx.party)
    const next = LEVELS[s.level + 1]
    const perks = ctx.region.corridors.length
      ? PRICING.remitFeeByLevel.map((share, i) => ({ label: `Niveau ${i + 1} · ${LEVELS[i][1]}`, text: share === 1 ? 'Frais d’envoi normaux' : share === 0 ? 'Envois au pays sans frais' : `Frais d’envoi réduits de ${Math.round((1 - share) * 100)} %`, on: i <= s.level }))
      : []
    return { blocks: [
      { type: 'zellij', filled: s.tiles, total: TILES, level: s.level + 1, name: LEVELS[s.level][1],
        next: next ? `Encore ${next[0] - s.value} points pour « ${next[1]} »` : 'Votre zellij est complet', perks },
      { type: 'score', value: s.value, note: `Calculée à partir de vos engagements tenus avec des personnes différentes. Vous seul la voyez.${s.penalty ? ` Retards et litiges perdus : −${s.penalty}.` : ''}`, signals: s.signals.map(x => ({ label: x.label, pct: x.pct })) },
      { type: 'badges', title: 'Vos badges', items: await computeBadges(ctx.client, ctx.user, ctx.party, s),
        shared: ctx.user.share_badges, note: ctx.user.share_badges
          ? 'Vos badges obtenus sont visibles par les personnes qui ouvrent vos liens (acheteurs, clients, ouvriers). Votre score, lui, reste privé.'
          : 'Vos badges sont privés. Vous pouvez les montrer aux personnes qui ouvrent vos liens : un acheteur voit alors que d’autres vous ont fait confiance.' },
      { type: 'note', title: 'Comment poser une pièce', text: 'Chaque engagement tenu pose une pièce : une paie ou un paiement confirmé par l’autre personne, une cotisation versée, une étape validée. Les allers-retours avec la même personne ne comptent pas plus de trois fois.' }],
      actions: ['shareBadges'] }
  },
  actions: {
    // Opt-in: earned badges (never the score) on the person's link pages.
    shareBadges: {
      label: 'Montrer mes badges', icon: 'award',
      form: ctx => ({ title: ctx.user.share_badges ? 'Masquer mes badges' : 'Montrer mes badges',
        info: ctx.user.share_badges ? 'Vos badges ne seront plus visibles sur vos liens.' : 'Les personnes qui ouvrent vos liens verront vos badges obtenus (pas votre score, ni vos montants). Vous pouvez les masquer à tout moment.', fields: [] }),
      async run(ctx) {
        const on = !ctx.user.share_badges
        await ctx.client.query('UPDATE users SET share_badges=$2 WHERE id=$1', [ctx.user.id, on])
        return { message: on ? 'Vos badges sont visibles sur vos liens.' : 'Vos badges sont masqués.' }
      },
    },
  },
}

export { FX_E8_PER_EUR as _fx, convert as _convert, ctxFor as _ctxFor }
