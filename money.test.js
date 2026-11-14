import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool, tx, one, all, resetDb, user, act, quote, bal, healthy, settleAll, engine, rails, PIN, idem, partyOf, phone, REGIONS, account } from './helpers.js'

const { post, sys } = await import('../ledger.js')
const catalog = await import('../catalog.js')

before(resetDb)
after(() => pool.end())

test('ledger refuses unbalanced, fractional and overdrawing entries, and postings are append-only', async () => {
  await tx(async c => {
    const a = await account(c, 'tA', 'wallet', 'EUR'), b = await account(c, 'tB', 'wallet', 'EUR')
    await assert.rejects(post(c, { kind: 'x', lines: [{ account: a, amount: -5 }, { account: b, amount: 4 }] }), /balance/)
    await assert.rejects(post(c, { kind: 'x', lines: [{ account: a, amount: -0.5 }, { account: b, amount: 0.5 }] }), /integer/)
  })
  await assert.rejects(tx(async c => post(c, { kind: 'x', lines: [{ account: await account(c, 'tA', 'wallet', 'EUR'), amount: -1 }, { account: await account(c, 'tB', 'wallet', 'EUR'), amount: 1 }] })), /Solde insuffisant/)
  await tx(async c => post(c, { kind: 'x', lines: [{ account: await sys(c, 'rail', 'EUR'), amount: -100 }, { account: await account(c, 'tA', 'wallet', 'EUR'), amount: 100 }] }))
  await assert.rejects(pool.query('UPDATE postings SET amount = 1'), /append-only/)
  await assert.rejects(pool.query('DELETE FROM entries'), /append-only/)
  // Put the test money back so the books stay square for later checks.
  await tx(async c => post(c, { kind: 'x', lines: [{ account: await account(c, 'tA', 'wallet', 'EUR'), amount: -100 }, { account: await sys(c, 'rail', 'EUR'), amount: 100 }] }))
})

test('top-up only credits when the partner confirms', async () => {
  const u = await user('SN', 'seller')
  const r = await act(u, 'wallet', 'topup', { amount: '50000' })
  assert.match(r.done.message, /Demande envoyée/)
  assert.equal(await bal(u), 0, 'nothing before confirmation')
  await settleAll()
  assert.equal(await bal(u), 50000)
  await healthy(assert)
})

test('a quote moves nothing, writes nothing to the outbox, and needs the PIN to confirm', async () => {
  const a = await user('SN', 'driver', { fund: 30000 }), b = await user('SN', 'seller')
  const outboxBefore = (await one(pool, 'SELECT count(*)::int AS n FROM outbox')).n
  const q = await quote(a, 'wallet', 'withdraw', { amount: '1000' })
  assert.ok(q.intentId && q.review)
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM outbox')).n, outboxBefore, 'a review never queues an external call')
  assert.equal(await bal(a), 30000)
  await assert.rejects(engine.confirmIntent(a.id, q.intentId, { pin: '1111', idem: idem() }), /Code secret incorrect/)
  const key = idem()
  const first = await engine.confirmIntent(a.id, q.intentId, { pin: PIN, idem: key })
  const replay = await engine.confirmIntent(a.id, q.intentId, { pin: PIN, idem: key })
  assert.deepEqual(first, replay, 'same key returns the stored response')
  await assert.rejects(engine.confirmIntent(a.id, q.intentId, { pin: PIN, idem: idem() }), /expiré ou a déjà été utilisé/)
  assert.equal(await bal(a), 29000)
  // Send shows a masked name, never the full name.
  const s = await quote(a, 'wallet', 'send', { amount: '500', phone: b.phone })
  assert.ok(s.review.lines.some(([k, v]) => k === 'Destinataire' && /^\S+ \w\.$/.test(v)), 'recipient name is masked')
  await settleAll()
  await healthy(assert)
})

test('the confirmed amount must match the quote', async () => {
  const sender = await user('FR', 'sender', { fund: 500 })
  await act(sender, 'family', 'add', { phone: phone('SN'), name: 'Maman' })
  const b = await one(pool, 'SELECT id FROM beneficiaries WHERE user_id=$1', [sender.id])
  const q = await quote(sender, 'remit', 'send', { amount: '100', to: b.id })
  const before = catalog.FX_E8_PER_EUR.XOF
  catalog.FX_E8_PER_EUR.XOF = 66000000000n // the rate moves between quote and confirmation
  try {
    await assert.rejects(engine.confirmIntent(sender.id, q.intentId, { pin: PIN, idem: idem() }), /ont changé depuis le devis/)
  } finally { catalog.FX_E8_PER_EUR.XOF = before }
  assert.equal(await bal(sender), 50000)
})

test('idempotency: required, replayed once, and refused when reused for something else', async () => {
  const u = await user('SN', 'driver')
  await assert.rejects(engine.perform(u.id, 'shifts', 'trip', { input: { amount: '100' } }), /Idempotency-Key/)
  const key = idem()
  await engine.perform(u.id, 'shifts', 'trip', { input: { amount: '100' }, idem: key })
  await engine.perform(u.id, 'shifts', 'trip', { input: { amount: '100' }, idem: key })
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM shift_items WHERE user_id=$1', [u.id])).n, 1)
  await assert.rejects(engine.perform(u.id, 'shifts', 'trip', { input: { amount: '999' }, idem: key }), /autre opération/)
})

test('KYC limits: unverified users have low caps, verification raises them, balance caps protect recipients', async () => {
  const fresh = await user('FR', 'student', { kyc: 0 })
  await assert.rejects(act(fresh, 'wallet', 'topup', { amount: '200' }).then(settleAll).then(() => { throw new Error('should not credit') }), /should not credit|plafond/)
  assert.equal(await bal(fresh), 0, 'credit above the level-0 balance cap is refused')
  await act(fresh, 'wallet', 'verify', { idNumber: 'AB123456' })
  await act(fresh, 'wallet', 'topup', { amount: '200' }); await settleAll()
  assert.equal(await bal(fresh), 20000)
  const rich = await user('SN', 'seller', { fund: 900000 })
  await assert.rejects(act(rich, 'wallet', 'withdraw', { amount: '1500000' }), /plafond par opération/)
  await settleAll()
  await healthy(assert)
})

test('recipient lookups are rate-limited and unknown numbers do not reveal names', async () => {
  const u = await user('SN', 'driver', { fund: 1000 })
  await assert.rejects(quote(u, 'wallet', 'send', { amount: '10', phone: phone('SN') }), /pas encore de compte/)
  for (let i = 0; i < 39; i++) await quote(u, 'wallet', 'send', { amount: '10', phone: phone('SN') }).catch(() => {})
  await assert.rejects(quote(u, 'wallet', 'send', { amount: '10', phone: phone('SN') }), /Trop de recherches/)
})

test('corridors: only opened routes, only in held custody, never from a direct-payment country', async () => {
  const ma = await user('MA', 'maallem'), fr = await user('FR', 'builder', { fund: 3000 }), ae = await user('AE', 'worker', { fund: 1000 })
  await assert.rejects(engine.perform(ma.id, 'escrow', 'hold', { input: {}, idem: idem() }), /indisponible/, 'no custody in Morocco yet: holding funds is unavailable')
  await assert.rejects(act(ae, 'family', 'add', { phone: phone('GN'), name: 'X' }), /pas ouverts/, 'UAE has no corridor to Guinea')
  await assert.rejects(quote(ma, 'wallet', 'send', { amount: '10', phone: fr.phone }), /indisponible/)
  const q = await quote(fr, 'escrow', 'hold', { amount: '100', phone: phone('MA'), name: 'Hassan Benali', title: 'Dalle' })
  assert.ok(q.review.lines.some(([k, v]) => /recevra/.test(k) && /^1\s085 DH$/u.test(v)))
})

test('diaspora build: EUR client funds a stage, the artisan without the app is paid in MAD on validation', async () => {
  const builder = await user('FR', 'builder', { fund: 2000 })
  const artisanPhone = phone('MA')
  await act(builder, 'jobs', 'create', { title: 'Maison Benslimane', country: 'MA', phone: artisanPhone, name: 'Hassan Benali', stage1: 'Dalle', amount1: '10850' })
  const job = await one(pool, 'SELECT * FROM jobs WHERE created_by=$1', [builder.id])
  assert.equal(job.currency, 'MAD'); assert.equal(job.mode, 'held')
  const artisan = await one(pool, 'SELECT * FROM parties WHERE phone=$1', [artisanPhone])
  // The artisan requests funding from the public link? No: in held mode the artisan without the app is invited; the builder funds via escrow request created here.
  await tx(async c => {
    const { createRequest } = await import('../modules/escrow.js')
    const stage = await one(c, 'SELECT * FROM job_stages WHERE job_id=$1', [job.id])
    const r = await createRequest(c, { payee: artisan, payer: await partyOf(builder), amount: stage.amount, currency: 'MAD', title: 'Dalle', mode: 'held', stageId: stage.id })
    await c.query(`UPDATE job_stages SET status='requested', escrow_id=$2 WHERE id=$1`, [stage.id, r.id])
  })
  await act(builder, 'jobs', 'fund', {}, job.id)
  assert.equal(await bal(builder), 100000, '10 850 DH cost exactly 1 000 €')
  const { jobOps } = await import('../modules/jobs.js')
  await tx(c => jobOps.markDone(c, job.id, artisan))
  await act(builder, 'jobs', 'validate', {}, job.id)
  const payout = await one(pool, `SELECT * FROM provider_ops WHERE kind='payout' AND party_id=$1`, [artisan.id])
  assert.equal(payout.currency, 'MAD'); assert.equal(payout.amount, 1085000); assert.equal(payout.phone, artisanPhone)
  await settleAll()
  assert.equal((await one(pool, 'SELECT status FROM job_stages WHERE job_id=$1', [job.id])).status, 'paid')
  await healthy(assert)
})

test('escrow dispute needs two admins; a split pays both sides exactly', async () => {
  const payer = await user('SN', 'boutique', { fund: 100000 })
  const admin1 = await user('FR', 'sender', { roles: ['admin'] }), admin2 = await user('FR', 'sender', { roles: ['admin'] })
  const payeePhone = phone('SN')
  await act(payer, 'escrow', 'hold', { amount: '60000', phone: payeePhone, name: 'Moussa Diop', title: 'Stock de tissu' })
  const e = await one(pool, 'SELECT * FROM escrows WHERE title=$1', ['Stock de tissu'])
  await act(payer, 'escrow', 'dispute', { reason: 'Tissu abîmé' }, e.id)
  const d = await one(pool, 'SELECT * FROM disputes WHERE escrow_id=$1', [e.id])
  const { app } = await import('../index.js')
  const server = app.listen(0); const base = `http://localhost:${server.address().port}/api`
  try {
    const login = async u => {
      const jwt = (await import('jsonwebtoken')).default, { config } = await import('../config.js')
      const sid = (await one(pool, `INSERT INTO sessions (id, user_id, refresh_hash) VALUES (gen_random_uuid(), $1, 'x') RETURNING id`, [u.id])).id
      return jwt.sign({ sub: u.id, sid, typ: 'access' }, config.jwtSecret, { expiresIn: '5m' })
    }
    const call = async (token, path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) } }
    const t1 = await login(admin1), t2 = await login(admin2), tp = await login(payer)
    assert.equal((await call(tp, `/admin/disputes/${d.id}/propose`, {})).status, 403, 'non-admins cannot decide')
    assert.equal((await call(t1, `/admin/disputes/${d.id}/propose`, { outcome: 'split', payeeAmount: 20000, note: 'Moitié du lot abîmé' })).status, 200)
    assert.equal((await call(t1, `/admin/disputes/${d.id}/approve`, {})).status, 403, 'the proposer cannot approve')
    assert.equal((await call(t2, `/admin/disputes/${d.id}/approve`, {})).status, 200)
  } finally { server.close() }
  await settleAll()
  assert.equal(await bal(payer), 100000 - 60000 + 40000, 'the payer gets the rest back')
  const payout = await one(pool, `SELECT p.amount FROM provider_ops p JOIN parties pa ON pa.id=p.party_id WHERE pa.phone=$1`, [payeePhone])
  assert.equal(payout.amount, 20000)
  await healthy(assert)
})

test('a payout the partner rejects is reversed to the source', async () => {
  const u = await user('SN', 'seller', { fund: 10000 })
  await act(u, 'wallet', 'withdraw', { amount: '4000' })
  assert.equal(await bal(u), 6000)
  await settleAll('failed')
  assert.equal(await bal(u), 10000)
  await healthy(assert)
})

test('webhooks: signature required, duplicates ignored, wrong amounts refused', async () => {
  await assert.rejects(rails.handleWebhook('{"id":"x"}', { 'x-signature': 'nope' }), /Signature invalide/)
  const u = await user('SN', 'seller')
  await act(u, 'wallet', 'topup', { amount: '700' }); await rails.drainOutbox()
  const op = await one(pool, `SELECT * FROM provider_ops WHERE user_id IS NULL AND party_id=(SELECT id FROM parties WHERE user_id=$1)`, [u.id])
  const { createHmac } = await import('node:crypto'), { config } = await import('../config.js')
  const send = body => rails.handleWebhook(body, { 'x-signature': createHmac('sha256', config.partner.webhookSecret).update(body).digest('hex') })
  await assert.rejects(send(JSON.stringify({ id: 'e1', type: 'collection.succeeded', providerRef: op.provider_ref, amount: op.amount + 1, currency: op.currency })), /incohérents/)
  const ok = JSON.stringify({ id: 'e2', type: 'collection.succeeded', providerRef: op.provider_ref, amount: op.amount, currency: op.currency })
  await send(ok); assert.deepEqual(await send(ok), { duplicate: true })
  assert.equal(await bal(u), 700)
  await healthy(assert)
})

test('concurrency: parallel releases pay once, parallel sends never overdraw', async () => {
  const payer = await user('SN', 'boutique', { fund: 50000 })
  await act(payer, 'escrow', 'hold', { amount: '10000', phone: phone('SN'), name: 'Awa Sarr', title: 'Course concurrente' })
  const e = await one(pool, 'SELECT * FROM escrows WHERE title=$1', ['Course concurrente'])
  const quotes = await Promise.all(Array.from({ length: 6 }, () => quote(payer, 'escrow', 'release', {}, e.id)))
  const results = await Promise.allSettled(quotes.map(q => engine.confirmIntent(payer.id, q.intentId, { pin: PIN, idem: idem() })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'exactly one release succeeds')
  const sender = await user('SN', 'driver', { fund: 1000 }), to = await user('SN', 'seller')
  const sendQuotes = await Promise.all(Array.from({ length: 5 }, () => quote(sender, 'wallet', 'send', { amount: '300', phone: to.phone })))
  const sends = await Promise.allSettled(sendQuotes.map(q => engine.confirmIntent(sender.id, q.intentId, { pin: PIN, idem: idem() })))
  assert.equal(sends.filter(r => r.status === 'fulfilled').length, 3)
  assert.equal(await bal(sender), 100)
  await settleAll()
  await healthy(assert)
})

test('catalog validation refuses a broken configuration at boot', () => {
  const broken = structuredClone(catalog.REGIONS.SN.personas.seller)
  catalog.REGIONS.SN.personas.broken = { ...broken, nav: ['nope'] }
  try { assert.throws(() => catalog.validateCatalog(engine.MODS), /nav module nope/) } finally { delete catalog.REGIONS.SN.personas.broken }
})
