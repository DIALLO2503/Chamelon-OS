// Fixes from the external audit: tontine defaults, personal data out of the ledger and erasure, the public upload cap,
// the escrow protection fee and prices in the runtime catalog, and the account language.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { pool, one, all, tx, resetDb, user, act, bal, healthy, engine, partyOf, linkFor } from './helpers.js'

const runtime = await import('../catalog-runtime.js')
const { PRICING } = await import('../catalog.js')
const { computeScore } = await import('../modules/work.js')
let server, base
before(async () => {
  await resetDb(); runtime.resetCatalog()
  const { app } = await import('../index.js')
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://localhost:${server.address().port}/api`
})
after(async () => { server.close(); runtime.resetCatalog(); await pool.end() })

const tontineOf = u => one(pool, 'SELECT * FROM tontines WHERE organiser_id=$1 ORDER BY created_at DESC LIMIT 1', [u.id])
const pastGrace = id => pool.query(`UPDATE tontines SET next_due = CURRENT_DATE - 10 WHERE id=$1`, [id])

test('tontine: after the grace period the organiser closes the round; absentees are recorded and penalised', async () => {
  const org = await user('MA', 'hanout'), a = await user('MA', 'parent'), b = await user('MA', 'ouvrier')
  await act(org, 'tontine', 'create', { name: 'Daret du marché', amount: '300', frequency: 'monthly', members: `${a.phone}, ${b.phone}` })
  const t = await tontineOf(org)
  await act(a, 'tontine', 'accept', {}, t.id); await act(b, 'tontine', 'accept', {}, t.id)
  await act(org, 'tontine', 'contribute', {}, t.id)           // the organiser pays; a and b do not
  await assert.rejects(act(org, 'tontine', 'closeRound', {}, t.id), /pas être clos|Possible/, 'not before the grace period')
  await pastGrace(t.id)
  const home = await engine.home(org.id)
  assert.ok(home.blocks.some(x => /retard de plus de 7 jours/.test(x.text ?? '')), 'the organiser is told the round can be closed')
  await act(org, 'tontine', 'closeRound', {}, t.id)
  const after = await one(pool, 'SELECT * FROM tontines WHERE id=$1', [t.id])
  assert.equal(after.round, 2, 'the group moves on instead of freezing')
  const defaults = await all(pool, 'SELECT party_id FROM tontine_defaults WHERE tontine_id=$1', [t.id])
  assert.equal(defaults.length, 2)
  const s = await computeScore(pool, a, await partyOf(a))
  assert.ok(s.penalty >= 60, 'a default costs reputation')
})

test('tontine: dissolving a held group refunds the current round to whoever paid', async () => {
  const org = await user('SN', 'boutique', { fund: 50000 }), a = await user('SN', 'parent', { fund: 50000 })
  await act(org, 'tontine', 'create', { name: 'Natt du quartier', amount: '10000', frequency: 'monthly', members: a.phone })
  const t = await tontineOf(org)
  await act(a, 'tontine', 'accept', {}, t.id)
  await act(a, 'tontine', 'contribute', {}, t.id)
  assert.equal(await bal(a), 40000)
  await act(org, 'tontine', 'dissolve', {}, t.id)
  assert.equal(await bal(a), 50000, 'refunded')
  assert.equal((await one(pool, 'SELECT status FROM tontines WHERE id=$1', [t.id])).status, 'dissolved')
  await healthy(assert)
})

test('ledger lines carry no personal data; an erased account keeps its amounts but no longer says who it was', async () => {
  const s = await user('SN', 'seller', { fund: 20000 }), r = await user('SN', 'driver')
  await act(s, 'wallet', 'send', { amount: '5000', phone: r.phone, note: 'Loyer de Fatou' })
  const lines = await all(pool, `SELECT p.id, p.title, p.cp_party, d.title AS label FROM postings p JOIN accounts a ON a.id=p.account_id LEFT JOIN posting_details d ON d.posting_id=p.id WHERE a.owner=$1`, [r.id])
  assert.ok(lines.every(l => l.title === null && l.cp_party === null), 'the append-only rows hold no names or free text')
  assert.ok(lines.some(l => l.label === 'Loyer de Fatou'), 'the label lives in the erasable table')
  const feed = (await engine.home(r.id)).blocks.find(b => b.type === 'feed')
  assert.ok(JSON.stringify(feed).includes('Loyer de Fatou'), 'and still shows in the feed')

  const { eraseUser } = await import('../admin.js')
  await assert.rejects(tx(c => eraseUser(c, r.id)), /demander la fermeture/)
  await pool.query('UPDATE users SET closure_requested_at=now() WHERE id=$1', [r.id])
  await assert.rejects(tx(c => eraseUser(c, r.id)), /solde/, 'money still on the account')
  await act(r, 'wallet', 'withdraw', { amount: '5000' })
  await tx(c => eraseUser(c, r.id))
  const gone = await one(pool, 'SELECT name, phone, erased_at FROM users WHERE id=$1', [r.id])
  assert.equal(gone.name, 'Compte effacé'); assert.match(gone.phone, /^erased:/); assert.ok(gone.erased_at)
  const left = await all(pool, `SELECT d.title FROM posting_details d JOIN postings p ON p.id=d.posting_id JOIN accounts a ON a.id=p.account_id WHERE a.owner=$1`, [r.id])
  assert.ok(left.every(l => l.title === null), 'labels scrubbed')
  assert.ok((await all(pool, `SELECT 1 FROM postings p JOIN accounts a ON a.id=p.account_id WHERE a.owner=$1`, [r.id])).length > 0, 'ledger lines kept')
  await healthy(assert)
})

test('a public link can upload at most 12 photos a day', async () => {
  const art = await user('MA', 'maallem'), client = await user('MA', 'parent')
  await act(art, 'jobs', 'create', { title: 'Mur du jardin', phone: client.phone, name: 'Client', stage1: 'Fondations', amount1: '1000' })
  const job = await one(pool, 'SELECT id FROM jobs WHERE created_by=$1', [art.id])
  const token = await linkFor('job', job.id, (await partyOf(art)).id)
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#808080' } }).png().toBuffer()
  const send = () => fetch(`${base}/public/${token}/upload`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })
  for (let i = 0; i < 12; i++) assert.equal((await send()).status, 200)
  assert.equal((await send()).status, 429)
})

test('escrow protection fee from the runtime catalog: taken at release, priced per version, validated', async () => {
  assert.ok((await runtime.overlayErrors({ pricing: { escrowFeeBps: 900 } })).some(e => /escrowFeeBps/.test(e)), 'more than 5 % is refused')
  assert.ok((await runtime.overlayErrors({ pricing: { remitFeeByLevel: [1, 1, 0.5] } })).some(e => /remitFeeByLevel/.test(e)))
  const a1 = await user('FR', 'sender', { roles: ['admin'] }), a2 = await user('FR', 'sender', { roles: ['admin'] })
  const current = (await runtime.catalogState()).active.overlay
  const id = await runtime.proposeVersion({ overlay: { ...current, pricing: { escrowFeeBps: 150 } }, note: 'Frais de protection 1,5 %', adminId: a1.id })
  await runtime.approveVersion(id, a2.id)
  assert.equal(PRICING.escrowFeeBps, 150)
  const payer = await user('SN', 'boutique', { fund: 100000 }), payee = await user('SN', 'seller')
  await act(payer, 'escrow', 'hold', { amount: '20000', phone: payee.phone, name: 'Vendeuse', title: 'Lot de pagnes' })
  const e = await one(pool, 'SELECT id FROM escrows WHERE payee_party=$1', [(await partyOf(payee)).id])
  await act(payer, 'escrow', 'release', {}, e.id)
  assert.equal(await bal(payee), 19700, '20 000 minus 1,5 %')
  await healthy(assert)
  runtime.resetCatalog()
  assert.equal(PRICING.escrowFeeBps, 0)
  assert.deepEqual(PRICING.remitFeeByLevel, [1, 1, 0.5, 0.25], 'no reputation level makes sending free')
})

test('the account language translates module names and quick actions', async () => {
  const u = await user('MA', 'seller')
  await pool.query(`UPDATE users SET locale='ar' WHERE id=$1`, [u.id])
  const me = await engine.me(u.id)
  assert.equal(me.user.locale, 'ar')
  assert.equal(me.experience.nav[0].label, 'الرئيسية')
  assert.equal(me.experience.nav.find(m => m.id === 'orders').label, 'الطلبات')
})
