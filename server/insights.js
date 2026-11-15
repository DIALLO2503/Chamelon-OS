import { all, one } from './db.js'
import { balanceOf } from './ledger.js'

// Money in and out per day for the user's own money, in their currency, over the last `months` calendar months.
// held: postings on the wallet (the shadow ledger). record: payments the other person confirmed.
// Days and weekdays come from the database clock, so every figure agrees with the rest of the app.
async function dailyFlows(ctx, months) {
  const since = `date_trunc('month', now()) - make_interval(months => ${months - 1})`
  const rows = ctx.held
    ? await all(ctx.client, `SELECT to_char(p.created_at, 'YYYY-MM-DD') AS day, extract(isodow FROM p.created_at)::int AS dow,
          COALESCE(SUM(p.amount) FILTER (WHERE p.amount > 0), 0)::bigint AS inn, COALESCE(SUM(-p.amount) FILTER (WHERE p.amount < 0), 0)::bigint AS out
        FROM postings p WHERE p.account_id=$1 AND p.created_at >= ${since} GROUP BY 1, 2`, [(await ctx.wallet()).id])
    : await all(ctx.client, `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, extract(isodow FROM created_at)::int AS dow,
          COALESCE(SUM(amount) FILTER (WHERE payee_party=$1), 0)::bigint AS inn, COALESCE(SUM(amount) FILTER (WHERE payer_party=$1), 0)::bigint AS out
        FROM recorded_payments WHERE status='confirmed' AND currency=$2 AND (payee_party=$1 OR payer_party=$1) AND created_at >= ${since} GROUP BY 1, 2`, [ctx.party.id, ctx.cur.code])
  const { today } = await one(ctx.client, `SELECT to_char(now(), 'YYYY-MM-DD') AS today`)
  return { rows, today }
}

const monthKey = day => day.slice(0, 7)
const shiftMonth = (key, n) => {
  const [y, m] = key.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
const monthLabel = key => new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' }).format(new Date(`${key}-01T00:00:00Z`)).replace('.', '')
const sum = (rows, field) => rows.reduce((s, r) => s + r[field], 0)
const pct = (now, before) => Math.round(((now - before) / before) * 100)
const signed = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} %`

// Six months of money received, with this month compared to the same days of last month (a fair comparison mid-month).
export async function trendBlock(ctx, title, months = 6) {
  const { rows, today } = await dailyFlows(ctx, months)
  if (!rows.some(r => r.inn > 0)) return null
  const cur = monthKey(today), dayOfMonth = Number(today.slice(8)), prev = shiftMonth(cur, -1)
  const keys = Array.from({ length: months }, (_, i) => shiftMonth(cur, i - months + 1))
  const bars = keys.map(k => {
    const value = sum(rows.filter(r => monthKey(r.day) === k), 'inn')
    return { label: monthLabel(k), value, display: ctx.f(value), current: k === cur }
  })
  const mine = rows.filter(r => monthKey(r.day) === cur)
  const inn = sum(mine, 'inn'), out = sum(mine, 'out')
  const prevSame = sum(rows.filter(r => monthKey(r.day) === prev && Number(r.day.slice(8)) <= dayOfMonth), 'inn')
  const delta = prevSame > 0 ? pct(inn, prevSame) : null
  return {
    type: 'trend', title,
    headline: ctx.f(inn), caption: ctx.held ? 'Entrées ce mois' : 'Reçu ce mois, confirmé',
    delta: delta === null ? null : { text: `${signed(delta)} vs même période le mois dernier`, tone: delta > 0 ? 'ok' : delta < 0 ? 'bad' : '' },
    bars,
    kpis: [{ label: 'Sorties ce mois', value: ctx.f(out) }, { label: 'Net ce mois', value: (inn - out < 0 ? '−' : '') + ctx.f(Math.abs(inn - out)), tone: inn - out < 0 ? 'bad' : 'ok' }],
  }
}

const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
const MIN_ACTIVE_DAYS = 6   // below this, a "best day" is noise
const BEST_DAY_LIFT = 30    // % above an average weekday before it is worth saying
const RUNWAY_DAYS = 7       // warn when the balance covers less than this many days of spending

// Alerts computed from the person's own money, the same way for every module and country. Each one is a plain insight block.
export async function moneyAlerts(ctx) {
  const { rows, today } = await dailyFlows(ctx, 3)
  const out = []
  const dayMs = d => Date.parse(`${d}T00:00:00Z`), now = dayMs(today)
  const within = n => rows.filter(r => now - dayMs(r.day) < n * 86400000)

  // 1. Cash gap. held: how many days the balance lasts at the last 30 days' spending. record: more paid than received this month.
  if (ctx.held) {
    const spent = sum(within(30), 'out'), perDay = Math.round(spent / 30)
    const balance = await balanceOf(ctx.client, (await ctx.wallet()).id)
    if (perDay > 0 && balance < perDay * RUNWAY_DAYS) {
      const days = Math.floor(balance / perDay)
      out.push({ type: 'insight', icon: 'triangle-alert', tone: 'warn', text: days === 0
        ? `Votre solde (${ctx.f(balance)}) ne couvre pas une journée de vos dépenses habituelles (${ctx.f(perDay)} par jour).`
        : `Au rythme des 30 derniers jours (${ctx.f(perDay)} de sorties par jour), votre solde couvre environ ${days} jour${days > 1 ? 's' : ''}.`,
        cta: { label: 'Voir le compte', module: 'wallet' } })
    }
  } else {
    const month = rows.filter(r => monthKey(r.day) === monthKey(today))
    const gap = sum(month, 'out') - sum(month, 'inn')
    if (gap > 0) out.push({ type: 'insight', icon: 'trending-down', tone: 'warn', text: `Ce mois, vous avez payé ${ctx.f(gap)} de plus que vous n’avez reçu (paiements confirmés).`, cta: { label: 'Voir le détail', module: 'wallet' } })
  }

  // 2. Best weekday for money received over the last 8 weeks.
  const recent = within(56).filter(r => r.inn > 0)
  if (recent.length >= MIN_ACTIVE_DAYS) {
    const byDow = Array(7).fill(0)
    for (const r of recent) byDow[r.dow - 1] += r.inn
    // Compared with the weekdays that bring money at all, so closed days do not inflate the figure.
    const open = byDow.filter(v => v > 0)
    const avg = open.reduce((s, v) => s + v, 0) / open.length, best = byDow.indexOf(Math.max(...byDow))
    const lift = Math.round((byDow[best] / avg - 1) * 100)
    if (lift >= BEST_DAY_LIFT) {
      const sells = ctx.persona.nav.includes('orders')
      out.push({ type: 'insight', icon: 'calendar-days', text: `Vos encaissements sont les plus forts le ${WEEKDAYS[best]} : +${lift} % par rapport à la moyenne de vos jours d’activité (8 dernières semaines).${sells ? ' Envoyez vos demandes de paiement la veille.' : ''}`,
        ...(sells ? { cta: { label: 'Voir les commandes', module: 'orders' } } : {}) })
    }
  }
  return out
}
