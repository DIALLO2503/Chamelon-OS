// Home trend and money alerts, checked against a fake database client: no PostgreSQL needed.
process.env.NEXUS_ENV = 'test'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { trendBlock, moneyAlerts } = await import('../insights.js')
const { fmt } = await import('../core.js')
await import('../engine.js') // loading the engine validates the catalog, including the new home widgets

const TODAY = '2026-11-15'
const MAD = { code: 'MAD', symbol: 'DH', decimals: 2 }
const dow = d => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1
const days = list => list.map(([day, inn, out = 0]) => ({ day, dow: dow(day), inn, out }))

function ctx({ held = false, rows = [], balance = 0, nav = ['orders'] } = {}) {
  return {
    held, cur: MAD, party: { id: 'p1' }, persona: { nav },
    f: m => fmt(m, MAD),
    wallet: async () => ({ id: 'w1' }),
    client: { query: async sql => ({ rows: sql.includes('AS today') ? [{ today: TODAY }] : sql.includes('SELECT balance') ? [{ balance }] : rows }) },
  }
}

test('trend: six months, current month compared with the same days of last month', async () => {
  const b = await trendBlock(ctx({ rows: days([['2026-10-05', 100000], ['2026-10-20', 900000], ['2026-11-03', 150000, 40000]]) }), 'Encaissements')
  assert.equal(b.type, 'trend')
  assert.deepEqual(b.bars.map(x => x.label), ['juin', 'juil', 'août', 'sept', 'oct', 'nov'])
  assert.equal(b.bars.at(-1).current, true)
  assert.equal(b.bars.at(-2).value, 1000000)
  assert.equal(b.headline, fmt(150000, MAD))
  assert.match(b.delta.text, /^\+50 %/) // 1 500 DH vs 1 000 DH received on Oct 1-15, not the full month
  assert.equal(b.kpis[1].value, fmt(110000, MAD))
})

test('trend: no block when nothing was received', async () => {
  assert.equal(await trendBlock(ctx(), 'x'), null)
})

test('alerts: record custody warns when more was paid than received this month', async () => {
  const [a, ...rest] = await moneyAlerts(ctx({ rows: days([['2026-11-02', 10000, 60000]]) }))
  assert.equal(rest.length, 0)
  assert.equal(a.tone, 'warn')
  assert.ok(a.text.includes(fmt(50000, MAD)))
})

test('alerts: held custody warns when the balance covers less than a week of spending', async () => {
  const [a] = await moneyAlerts(ctx({ held: true, rows: days([['2026-11-10', 0, 90000]]), balance: 10000 }))
  assert.match(a.text, /environ 3 jours/)
  assert.deepEqual(await moneyAlerts(ctx({ held: true, rows: days([['2026-11-10', 0, 90000]]), balance: 500000 })), [])
})

test('alerts: best weekday, compared with the other days that bring money', async () => {
  const list = []
  for (let w = 0; w < 7; w++) for (const [off, amt] of [[0, 20000], [2, 20000], [4, 90000]]) list.push([new Date(Date.UTC(2026, 8, 28 + w * 7 + off)).toISOString().slice(0, 10), amt])
  const best = (await moneyAlerts(ctx({ rows: days(list) }))).find(x => x.icon === 'calendar-days')
  assert.match(best.text, /vendredi : \+108 %/)
  assert.equal(best.cta.module, 'orders')
  const noOrders = (await moneyAlerts(ctx({ rows: days(list), nav: ['jobs'] }))).find(x => x.icon === 'calendar-days')
  assert.equal(noOrders.cta, undefined)
})

test('alerts: too little activity says nothing', async () => {
  assert.deepEqual(await moneyAlerts(ctx({ rows: days([['2026-11-06', 90000], ['2026-11-07', 1000]]) })), [])
})
