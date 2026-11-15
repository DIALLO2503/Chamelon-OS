// Trust badges (private by default, opt-in on link pages) and progressive disclosure (what the app shows grows with the level).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool, one, resetDb, user, act, engine, partyOf, linkFor } from './helpers.js'

let server, base
before(async () => {
  await resetDb()
  const { app } = await import('../index.js')
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://localhost:${server.address().port}/api`
})
after(async () => { server.close(); await pool.end() })

// Gives a user `n` confirmed payments with `people` different counterparties, as the confirmation flow leaves them.
async function confirmedPayments(u, n, people, { ref = null, payer = false, daysApart = 0 } = {}) {
  const me = await partyOf(u)
  for (let i = 0; i < n; i++) {
    const phone = `+2126777${String(1000 + (i % people) + n * 7).slice(-4)}${String(i % people).padStart(1, '0')}`
    await pool.query('INSERT INTO parties (id, phone, name) VALUES (gen_random_uuid(), $1, $2) ON CONFLICT (phone) DO NOTHING', [phone, `Personne ${i % people}`])
    const other = await one(pool, 'SELECT id FROM parties WHERE phone=$1', [phone])
    await pool.query(`INSERT INTO recorded_payments (id, payer_party, payee_party, amount, currency, purpose, ref, recorded_by, status, created_at, confirmed_at)
      VALUES (gen_random_uuid(), $1, $2, 10000, 'MAD', 'Test', $3, $4, 'confirmed', now() - make_interval(days => $5), now())`,
      [payer ? me.id : other.id, payer ? other.id : me.id, ref ? `${ref}${i}` : null, me.id, i * daysApart])
  }
}
const badge = (view, id) => view.blocks.find(b => b.type === 'badges').items.find(b => b.id === id)

test('badges come from commitments others confirmed: progress first, earned at the threshold', async () => {
  const u = await user('MA', 'maallem')
  await confirmedPayments(u, 6, 3)
  let view = await engine.moduleView(u.id, 'score')
  assert.equal(badge(view, 'confirmed').earned, false)
  assert.ok(badge(view, 'confirmed').have > 0, 'progress is shown')
  assert.equal(badge(view, 'boss'), undefined, 'a badge not started is not listed')

  await confirmedPayments(u, 10, 6)
  await confirmedPayments(u, 3, 2, { ref: 'crew:t', payer: true, daysApart: 7 }) // three Friday paydays, a week apart
  view = await engine.moduleView(u.id, 'score')
  assert.equal(badge(view, 'confirmed').earned, true)
  assert.equal(badge(view, 'boss').earned, true, 'crew pay confirmed on three different weeks')
  const card = (await engine.home(u.id)).blocks.find(b => b.type === 'scorecard')
  assert.ok(card.badges.some(b => b.label === 'Patron fiable'), 'earned badges on the home card')
})

test('a link page shows the badges only when their owner chose to, and never the score', async () => {
  const seller = await user('MA', 'seller')
  await confirmedPayments(seller, 12, 6)
  await act(seller, 'orders', 'create', { item: 'Caftan', amount: '500', customer: 'Nadia', phone: '+212600555001' })
  const order = await one(pool, 'SELECT id FROM orders WHERE seller_id=$1', [seller.id])
  const buyer = await one(pool, 'SELECT id FROM parties WHERE phone=$1', ['+212600555001'])
  const token = await linkFor('order', order.id, buyer.id)
  const page = async () => (await fetch(`${base}/public/${token}`)).json()

  assert.equal((await page()).trust, undefined, 'private by default')
  await act(seller, 'score', 'shareBadges')
  const shown = await page()
  assert.deepEqual(shown.trust.badges.map(b => b.label), ['Paiements confirmés'])
  assert.deepEqual(Object.keys(shown.trust), ['name', 'badges'], 'only a name and badge labels: no score, no amounts')
  assert.doesNotMatch(JSON.stringify(shown.trust), /DH|score/i)
  await act(seller, 'score', 'shareBadges')
  assert.equal((await page()).trust, undefined, 'and hidden again')
})

test('progressive disclosure: locked modules are hidden, not forbidden, and quick actions grow with the level', async () => {
  const shop = await user('MA', 'hanout')
  let me = (await engine.me(shop.id)).experience
  assert.equal(me.level.level, 1)
  assert.ok(!me.nav.some(m => m.id === 'invoices') && !me.services.some(m => m.id === 'invoices'), 'invoices hidden at the first level')
  assert.deepEqual(me.locked.map(m => [m.id, m.level, m.name]), [['invoices', 2, 'Motif']])
  assert.equal(me.actions.length, 2, 'two quick actions to start')
  assert.equal((await engine.moduleView(shop.id, 'invoices')).id, 'invoices', 'still reachable from a link or an insight')

  const trader = await user('AE', 'trader')
  assert.ok((await engine.me(trader.id)).experience.nav.some(m => m.id === 'invoices'), 'never locked when it is the profile’s first module')

  await confirmedPayments(shop, 12, 9) // 9 people: enough for "Motif"
  me = (await engine.me(shop.id)).experience
  assert.equal(me.level.level, 2)
  assert.ok(me.nav.some(m => m.id === 'invoices'))
  assert.equal(me.locked.length, 0)
  assert.equal(me.actions.length, 3)

  const home = await engine.home(shop.id)
  const up = home.blocks.find(b => b.icon === 'sparkles')
  assert.match(up.text, /niveau 2 « Motif ».*Factures.*action rapide/)
  assert.equal(await one(pool, `SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND template='level.up'`, [shop.id]).then(r => r.n), 1)
  assert.equal((await engine.home(shop.id)).blocks.find(b => b.icon === 'sparkles'), undefined, 'celebrated once')
})
