import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool, tx, one, all, resetDb, user, act, quote, bal, healthy, settleAll, engine, rails, PIN, idem, partyOf, partyByPhone, phone, linkFor } from './helpers.js'

let server, base
before(async () => {
  await resetDb()
  const { app } = await import('../index.js')
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://localhost:${server.address().port}/api`
})
after(async () => { server.close(); await pool.end() })

const http = async (path, { body, token, cookie, method } = {}) => {
  const r = await fetch(base + path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), 'Idempotency-Key': idem() }, body: body && JSON.stringify(body) })
  return { status: r.status, cookie: r.headers.get('set-cookie'), ...(await r.json()) }
}
// Acts on a public link the way a person without the app would: asks for a code on their phone, then acts.
async function linkAct(token, action, input = {}, { otp = true } = {}) {
  let code
  if (otp) code = (await http(`/public/${token}/otp`, { body: {} })).sandboxCode
  return http(`/public/${token}/act`, { body: { action, code, input } })
}

test('sign-up and sign-in: verified phone, matching country, PIN, rotating refresh, revocation', async () => {
  const p = phone('SN')
  assert.equal((await http('/auth/register', { body: { name: 'X', region: 'SN', persona: 'driver', pin: '4826' } })).status, 401, 'no sign-up without a verified phone')
  const { sandboxCode } = await http('/auth/otp', { body: { phone: p } })
  const { signupToken } = await http('/auth/verify', { body: { phone: p, code: sandboxCode } })
  assert.equal((await http('/auth/register', { body: { signupToken, name: 'Awa Gueye', region: 'FR', persona: 'student', pin: '4826' } })).status, 400, 'a Senegalese number cannot open a French account')
  assert.equal((await http('/auth/register', { body: { signupToken, name: 'Awa Gueye', region: 'SN', persona: 'driver', pin: '1234' } })).status, 400, 'obvious PINs are refused')
  const reg = await http('/auth/register', { body: { signupToken, name: 'Awa Gueye', region: 'SN', persona: 'driver', pin: '4826' } })
  assert.ok(reg.accessToken)
  const me = await http('/me', { token: reg.accessToken })
  assert.deepEqual(me.experience.nav.map(m => m.label), ['Accueil', 'Gains', 'Natt', 'Compte', 'Services'])
  // Sign in again on a new device: code, then PIN. Five wrong PINs lock the account for 15 minutes.
  const c2 = (await http('/auth/otp', { body: { phone: p } })).sandboxCode
  const { pinToken } = await http('/auth/verify', { body: { phone: p, code: c2 } })
  const login = await http('/auth/pin', { body: { pinToken, pin: '4826' } })
  assert.ok(login.accessToken)
  const cookie = login.cookie.split(';')[0]
  const refreshed = await http('/auth/refresh', { body: {}, cookie })
  assert.ok(refreshed.accessToken)
  assert.equal((await http('/auth/refresh', { body: {}, cookie })).status, 401, 'an old refresh token is dead after rotation')
  await http('/auth/logout', { body: {}, cookie: refreshed.cookie.split(';')[0] })
  assert.equal((await http('/me', { token: refreshed.accessToken })).status, 401, 'logout revokes the session')
})

test('login codes: wrong guesses count over 24 hours, re-sending does not reset them', async () => {
  const p = phone('MA')
  for (let i = 0; i < 2; i++) {
    await http('/auth/otp', { body: { phone: p } })
    for (let j = 0; j < 5; j++) await http('/auth/verify', { body: { phone: p, code: '000000' } })
  }
  assert.equal((await http('/auth/otp', { body: { phone: p } })).status, 429)
})

test('stage 1 (no money moves): a Moroccan artisan and a client without the app record and confirm each payment', async () => {
  const artisan = await user('MA', 'maallem')
  const clientPhone = phone('MA')
  await act(artisan, 'jobs', 'create', { title: 'Cuisine Maârif', phone: clientPhone, name: 'Salma Tazi', stage1: 'Démolition', amount1: '3000', stage2: 'Carrelage', amount2: '5000' })
  const job = await one(pool, 'SELECT * FROM jobs WHERE created_by=$1', [artisan.id])
  assert.equal(job.mode, 'recorded')
  const client = await partyByPhone(clientPhone)
  const token = await linkFor('job', job.id, client.id)
  // The link page works without OTP for viewing, and masks the artisan's name.
  const page = await http(`/public/${token}`)
  assert.match(page.lines[0][1], /^\S+ \w\.$/)
  assert.equal((await http(`/public/${token}/act`, { body: { action: 'validate' } })).status, 404, 'nothing to validate before the work is done')
  await act(artisan, 'jobs', 'done', {}, job.id)
  assert.equal((await http(`/public/${token}/act`, { body: { action: 'validate', code: '000000' } })).status, 401, 'acting needs the code sent to the client phone')
  assert.equal((await linkAct(token, 'validate')).status, 200)
  assert.equal((await linkAct(token, 'claimPaid')).status, 200)
  await act(artisan, 'jobs', 'markReceived', {}, job.id)
  const stages = await all(pool, 'SELECT status FROM job_stages WHERE job_id=$1 ORDER BY position', [job.id])
  assert.deepEqual(stages.map(s => s.status), ['paid', 'planned'])
  const rp = await one(pool, `SELECT * FROM recorded_payments WHERE payee_party=(SELECT id FROM parties WHERE user_id=$1)`, [artisan.id])
  assert.equal(rp.status, 'confirmed'); assert.equal(rp.amount, 300000)
  const home = await engine.home(artisan.id)
  assert.match(home.blocks[0].caption, /Reçu ce mois, confirmé/)
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM postings')).n, 0, 'no money moved through Nexus in stage 1')
})

test('stage 2 protected order: a buyer without the app pays by mobile money, money is released on delivery confirmation', async () => {
  const seller = await user('SN', 'seller')
  const buyerPhone = phone('SN')
  const r = await act(seller, 'orders', 'create', { item: 'Robe wax', amount: '12500', customer: 'Awa', phone: buyerPhone })
  assert.match(r.done.share.whatsapp, /^https:\/\/wa\.me\/\?text=/)
  const token = r.done.share.url.split('/l/')[1]
  assert.equal((await http(`/public/${token}/act`, { body: { action: 'pay', input: { phone: buyerPhone } } })).status, 200)
  await settleAll()
  const o = await one(pool, 'SELECT * FROM orders WHERE seller_id=$1', [seller.id])
  assert.equal(o.status, 'paid'); assert.equal(await bal(seller), 0, 'held, not paid to the seller yet')
  // A second payment of the same order is returned to the payer automatically.
  await tx(c => rails.startCollection(c, { amount: o.amount, currency: 'XOF', phone: buyerPhone, purpose: { type: 'order', orderId: o.id } }))
  await settleAll(); await settleAll()
  assert.ok(await one(pool, `SELECT 1 FROM provider_ops WHERE kind='payout' AND phone=$1 AND status='succeeded'`, [buyerPhone]), 'duplicate payment refunded')
  await act(seller, 'orders', 'deliver', {}, o.id)
  assert.equal((await linkAct(token, 'confirmReceived')).status, 200)
  assert.equal(await bal(seller), 12500)
  await healthy(assert)
})

test('protected orders release automatically after the delay if the buyer stays silent', async () => {
  const seller = await user('SN', 'seller'), buyer = await user('SN', 'driver', { fund: 20000 })
  const r = await act(seller, 'orders', 'create', { item: 'Sac', amount: '8000', customer: 'Ibou' })
  await act(buyer, 'wallet', 'pay', { code: r.done.copy })
  const o = await one(pool, 'SELECT * FROM orders WHERE seller_id=$1', [seller.id])
  await act(seller, 'orders', 'deliver', {}, o.id)
  await pool.query(`UPDATE escrows SET auto_release_at = now() - interval '1 minute' WHERE id=$1`, [o.escrow_id])
  const { autoRelease } = await import('../scheduler.js')
  await autoRelease()
  assert.equal(await bal(seller), 8000)
  assert.equal((await one(pool, 'SELECT status FROM orders WHERE id=$1', [o.id])).status, 'completed')
  await healthy(assert)
})

test('tontine with partner custody: invitations accepted, order drawn, pot paid when the round is full', async () => {
  const org = await user('SN', 'seller', { fund: 30000 }), m2 = await user('SN', 'driver', { fund: 30000 })
  const m3Phone = phone('SN')
  await act(org, 'tontine', 'create', { name: 'Natt du marché', amount: '10000', frequency: 'monthly', members: `${m2.phone}, ${m3Phone}` })
  const t = await one(pool, 'SELECT * FROM tontines WHERE organiser_id=$1', [org.id])
  assert.equal(t.status, 'forming')
  await assert.rejects(act(org, 'tontine', 'contribute', {}, t.id), /pas actif/)
  await act(m2, 'tontine', 'accept', {}, t.id)
  const token = await linkFor('tontine', t.id, (await partyByPhone(m3Phone)).id)
  assert.equal((await linkAct(token, 'accept')).status, 200)
  const active = await one(pool, 'SELECT * FROM tontines WHERE id=$1', [t.id])
  assert.equal(active.status, 'active')
  const positions = (await all(pool, 'SELECT position FROM tontine_members WHERE tontine_id=$1 ORDER BY position', [t.id])).map(r => r.position)
  assert.deepEqual(positions, [1, 2, 3])
  await act(org, 'tontine', 'contribute', {}, t.id)
  await act(m2, 'tontine', 'contribute', {}, t.id)
  await assert.rejects(act(m2, 'tontine', 'contribute', {}, t.id), /déjà/)
  assert.equal((await http(`/public/${token}/act`, { body: { action: 'pay', input: { phone: m3Phone } } })).status, 200)
  await settleAll(); await settleAll()
  const after = await one(pool, 'SELECT * FROM tontines WHERE id=$1', [t.id])
  assert.equal(after.round, 2, 'round complete, next one open')
  const pot = await one(pool, `SELECT balance FROM accounts WHERE owner=$1`, [`tontine:${t.id}`])
  assert.equal(pot.balance, 0, 'pot paid out')
  await healthy(assert)
})

test('agents are approved by an admin, cash-out needs the customer code, round trips earn no commission', async () => {
  const agent = await user('SN', 'agent', { fund: 500000 })
  assert.ok(await one(pool, `SELECT 1 FROM roles WHERE user_id=$1 AND role='agent' AND status='pending'`, [agent.id]), 'self-registered agents start pending')
  const customer = await user('SN', 'parent')
  await assert.rejects(quote(agent, 'float', 'cashIn', { amount: '1000', phone: customer.phone }), /indisponible/)
  await pool.query(`UPDATE roles SET status='active' WHERE user_id=$1 AND role='agent'`, [agent.id])
  await act(agent, 'float', 'cashIn', { amount: '100000', phone: customer.phone })
  assert.equal(await bal(customer), 100000)
  const code = (await act(customer, 'wallet', 'cashCode', { amount: '100000' })).done.copy
  assert.match(code, /^\d{8}$/)
  await act(agent, 'float', 'cashOut', { code })
  await assert.rejects(quote(agent, 'float', 'cashOut', { code }), /déjà utilisé/)
  assert.equal(await bal(customer), 0)
  await pool.query(`UPDATE commission_accruals SET created_at = now() - interval '25 hours'`)
  const { settleCommissions } = await import('../modules/work.js')
  await settleCommissions()
  const statuses = (await all(pool, 'SELECT status FROM commission_accruals WHERE agent_id=$1', [agent.id])).map(r => r.status)
  assert.deepEqual(statuses, ['withheld', 'withheld'], 'deposit + withdrawal with the same customer the same day pays nothing')
  assert.equal(await bal(agent), 500000)
  await healthy(assert)
})

test('scheduled transfers pay once per month even when two runs overlap', async () => {
  const sender = await user('FR', 'sender', { fund: 1000 })
  await act(sender, 'family', 'add', { phone: phone('GN'), name: 'Maman Conakry' })
  const b = await one(pool, 'SELECT id FROM beneficiaries WHERE user_id=$1', [sender.id])
  await act(sender, 'remit', 'schedule', { amount: '100', to: b.id, day: 5 })
  const { runDueSchedules } = await import('../modules/remit.js')
  await Promise.all([runDueSchedules('2099-01-05'), runDueSchedules('2099-01-05')])
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM remittances WHERE sender_id=$1', [sender.id])).n, 1)
  const payout = await one(pool, `SELECT * FROM provider_ops WHERE kind='payout' AND currency='GNF'`)
  assert.ok(payout.amount > 900000, 'recipient without the app is paid in GNF on mobile money')
  await settleAll()
  assert.equal(await bal(sender), 100000 - 10000 - 150)
  await healthy(assert)
})

test('credit book: WhatsApp reminder, customer reports repayment on the statement page, shop confirms', async () => {
  const shop = await user('MA', 'hanout')
  const custPhone = phone('MA')
  await act(shop, 'creditbook', 'add', { name: 'Youssef', phone: custPhone, amount: '180' })
  const cust = await one(pool, 'SELECT * FROM customers WHERE shop_id=$1', [shop.id])
  const r = await act(shop, 'creditbook', 'remind', {}, cust.id)
  const token = r.done.share.url.split('/l/')[1]
  const page = await http(`/public/${token}`)
  assert.match(page.lines[0][1], /180 DH/)
  assert.equal((await linkAct(token, 'claimPaid', { amount: '80' })).status, 200)
  const rp = await one(pool, `SELECT id FROM recorded_payments WHERE ref=$1`, [`credit:${cust.id}`])
  await act(shop, 'wallet', 'confirmRecorded', {}, rp.id)
  const { owedBy } = await import('../modules/commerce.js')
  assert.equal(await owedBy(pool, cust.id), 10000)
})

test('reputation counts distinct people, not repeated pings, and late tontine payments cost points', async () => {
  const a = await user('SN', 'driver', { fund: 50000 }), b = await user('SN', 'seller')
  for (let i = 0; i < 5; i++) await act(a, 'wallet', 'send', { amount: '10', phone: b.phone })
  const view = await engine.moduleView(b.id, 'score')
  const people = view.blocks.find(b => b.type === 'score').signals[0]
  assert.equal(Math.round(people.pct * 15), 1, 'five pings from one person count as one')
})

test('frozen accounts cannot move money; manual adjustments need a second admin', async () => {
  const u = await user('SN', 'seller', { fund: 5000 })
  const admin1 = await user('FR', 'sender', { roles: ['admin'] }), admin2 = await user('FR', 'sender', { roles: ['admin'] })
  const jwt = (await import('jsonwebtoken')).default, { config } = await import('../config.js')
  const tokenFor = async x => jwt.sign({ sub: x.id, sid: (await one(pool, `INSERT INTO sessions (id, user_id, refresh_hash) VALUES (gen_random_uuid(), $1, 'x') RETURNING id`, [x.id])).id, typ: 'access' }, config.jwtSecret, { expiresIn: '5m' })
  const [t1, t2] = await Promise.all([tokenFor(admin1), tokenFor(admin2)])
  const adj = await http('/admin/adjustments', { token: t1, body: { userId: u.id, amount: 250, reason: 'Geste commercial' } })
  assert.equal((await http(`/admin/adjustments/${adj.id}/approve`, { token: t1, body: {} })).status, 403)
  assert.equal((await http(`/admin/adjustments/${adj.id}/approve`, { token: t2, body: {} })).status, 200)
  assert.equal(await bal(u), 5250)
  const tu = await tokenFor(u)
  await http(`/admin/users/${u.id}/freeze`, { token: t1, body: { frozen: true, reason: 'Suspicion de fraude' } })
  assert.equal((await http('/me', { token: tu })).status, 401, 'freezing revokes sessions')
  await assert.rejects(act(u, 'wallet', 'withdraw', { amount: '100' }), /suspendu/)
  const overview = await http('/admin/overview', { token: t2 })
  assert.ok(overview.reconciliation.ok)
  await healthy(assert)
})

test('blue-collar: a foreman pays his crew, each worker confirms, and the pay builds the worker’s record and goal', async () => {
  const foreman = await user('MA', 'maallem'), w1 = await user('MA', 'ouvrier')
  const w2Phone = phone('MA')
  const r = await act(foreman, 'jobs', 'crew', { amount: '250', phones: `${w1.phone}, ${w2Phone}`, purpose: 'Journée chantier Maârif' })
  assert.match(r.done.message, /2 paies/)
  await act(w1, 'wallet', 'goal', { amount: '5000' })
  const rp = await one(pool, `SELECT id FROM recorded_payments WHERE payee_party=(SELECT id FROM parties WHERE user_id=$1)`, [w1.id])
  await act(w1, 'wallet', 'confirmRecorded', {}, rp.id)
  const token = await linkFor('recorded', (await one(pool, `SELECT r.id FROM recorded_payments r JOIN parties p ON p.id=r.payee_party WHERE p.phone=$1`, [w2Phone])).id, (await partyByPhone(w2Phone)).id)
  assert.equal((await linkAct(token, 'confirm')).status, 200, 'a worker without the app confirms from the link')
  const home = await engine.home(w1.id)
  const goal = home.blocks.find(b => b.type === 'goal')
  assert.equal(Math.round(goal.pct * 100), 5); assert.match(goal.detail, /250 DH reçus sur 5\s000 DH/u)
  const view = await engine.moduleView(w1.id, 'score')
  assert.equal(view.label, 'Niya'); assert.equal(view.blocks[0].type, 'zellij'); assert.equal(view.blocks[0].filled, 1)
})

test('reputation lowers the sending fee: level 3 pays half', async () => {
  const sender = await user('FR', 'sender', { fund: 500 })
  await act(sender, 'family', 'add', { phone: phone('SN'), name: 'Maman' })
  const b = await one(pool, 'SELECT id FROM beneficiaries WHERE user_id=$1', [sender.id])
  const fee = async () => (await quote(sender, 'remit', 'send', { amount: '100', to: b.id })).review.lines.find(l => l[0].startsWith('Frais'))
  assert.match((await fee())[1], /1,50/)
  // Kept commitments with many different people raise the level.
  const me = await partyOf(sender)
  for (let i = 0; i < 15; i++) {
    const other = await tx(c => c.query(`INSERT INTO parties (id, phone, name) VALUES (gen_random_uuid(), $1, 'P') RETURNING id`, [phone('FR')]))
    await pool.query(`INSERT INTO recorded_payments (id, payer_party, payee_party, amount, currency, purpose, recorded_by, status) VALUES (gen_random_uuid(), $1, $2, 100, 'EUR', 'x', $1, 'confirmed')`, [me.id, other.rows[0].id])
    await pool.query(`INSERT INTO escrows (id, payer_party, payee_party, currency, amount, title, status, mode) VALUES (gen_random_uuid(), $2, $1, 'EUR', 100, 'x', 'released', 'held')`, [me.id, other.rows[0].id])
  }
  const reduced = await fee()
  assert.match(reduced[0], /réduits/); assert.match(reduced[1], /0,75/)
})
