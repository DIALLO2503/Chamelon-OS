// Regression tests for the issues found while writing the documentation (docs/security.md, "Fixed").
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool, one, resetDb, user, act, quote, bal, healthy, settleAll, engine, rails, idem, partyOf, partyByPhone, phone, linkFor, REGIONS } from './helpers.js'

let server, base
before(async () => {
  await resetDb()
  const { app } = await import('../index.js')
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://localhost:${server.address().port}/api`
})
after(async () => { server.close(); await pool.end() })

const raw = async (path, body, headers = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
  return { status: r.status, ...(await r.json()) }
}
async function linkAct(token, action, input = {}) {
  const { sandboxCode: code } = await raw(`/public/${token}/otp`, '{}')
  return raw(`/public/${token}/act`, JSON.stringify({ action, code, input }))
}

test('a refused recorded payment puts the job stage back to "to pay", so the client can report it again', async () => {
  const artisan = await user('MA', 'maallem')
  const clientPhone = phone('MA')
  await act(artisan, 'jobs', 'create', { title: 'Salle de bain', phone: clientPhone, name: 'Salma Tazi', stage1: 'Plomberie', amount1: '2000' })
  const job = await one(pool, 'SELECT * FROM jobs WHERE created_by=$1', [artisan.id])
  const token = await linkFor('job', job.id, (await partyByPhone(clientPhone)).id)
  await act(artisan, 'jobs', 'done', {}, job.id)
  assert.equal((await linkAct(token, 'validate')).status, 200)
  assert.equal((await linkAct(token, 'claimPaid')).status, 200)
  const rp = await one(pool, `SELECT * FROM recorded_payments WHERE payee_party=$1 AND status='claimed'`, [(await partyOf(artisan)).id])
  await act(artisan, 'wallet', 'rejectRecorded', {}, rp.id)
  const stage = await one(pool, 'SELECT * FROM job_stages WHERE job_id=$1', [job.id])
  assert.equal(stage.status, 'validated')
  assert.equal((await one(pool, 'SELECT status FROM escrows WHERE id=$1', [stage.escrow_id])).status, 'requested')
  assert.equal((await linkAct(token, 'claimPaid')).status, 200, 'the client can report the payment again')
})

test('a remittance whose payout fails refunds the sender in full, fee included, and is marked failed', async () => {
  const sender = await user('FR', 'sender', { fund: 500 })
  await act(sender, 'family', 'add', { phone: phone('SN'), name: 'Maman' })
  const b = await one(pool, 'SELECT id FROM beneficiaries WHERE user_id=$1', [sender.id])
  await act(sender, 'remit', 'send', { amount: '100', to: b.id })
  assert.equal(await bal(sender), 50000 - 10000 - 150)
  await settleAll('failed')
  assert.equal(await bal(sender), 50000, 'sender refunded, fee included')
  assert.equal((await one(pool, 'SELECT status FROM remittances WHERE sender_id=$1', [sender.id])).status, 'failed')
  await act(sender, 'remit', 'send', { amount: '100', to: b.id })
  await settleAll()
  assert.equal((await one(pool, `SELECT status FROM remittances WHERE sender_id=$1 ORDER BY created_at DESC LIMIT 1`, [sender.id])).status, 'delivered')
  await healthy(assert)
})

test('an escrow release whose payout fails puts the money back in escrow', async () => {
  const payer = await user('SN', 'boutique', { fund: 50000 })
  await act(payer, 'escrow', 'hold', { amount: '20000', phone: phone('SN'), name: 'Awa Sarr', title: 'Lot de pagnes' })
  const e = await one(pool, 'SELECT * FROM escrows WHERE title=$1', ['Lot de pagnes'])
  await act(payer, 'escrow', 'release', {}, e.id)
  await settleAll('failed')
  assert.equal((await one(pool, 'SELECT status FROM escrows WHERE id=$1', [e.id])).status, 'held')
  assert.equal(await bal(payer), 30000)
  await act(payer, 'escrow', 'release', {}, e.id)
  await settleAll()
  assert.equal((await one(pool, 'SELECT status FROM escrows WHERE id=$1', [e.id])).status, 'released')
  await healthy(assert)
})

test('failed withdrawals do not use up the daily limit', async () => {
  const { single, daily } = REGIONS.SN.limits[0]
  const u = await user('SN', 'seller', { kyc: 0, fund: daily + single })
  await act(u, 'wallet', 'withdraw', { amount: String(single) })
  await act(u, 'wallet', 'withdraw', { amount: String(single) })
  await settleAll('failed')
  let sent = 0
  while (sent + single <= daily) { await act(u, 'wallet', 'withdraw', { amount: String(single) }); sent += single }
  await assert.rejects(act(u, 'wallet', 'withdraw', { amount: String(single) }), /plafond|limite/i)
  await settleAll()
  await healthy(assert)
})

test('a supplier invoice stays "paying" until the partner confirms, and reopens if the payment fails', async () => {
  const shop = await user('SN', 'boutique', { fund: 30000 })
  await act(shop, 'invoices', 'create', { supplier: 'Grossiste Diallo', amount: '10000' })
  const inv = await one(pool, 'SELECT * FROM invoices WHERE supplier=$1', ['Grossiste Diallo'])
  await act(shop, 'invoices', 'pay', { phone: phone('SN') }, inv.id)
  assert.equal((await one(pool, 'SELECT status FROM invoices WHERE id=$1', [inv.id])).status, 'paying')
  await settleAll('failed')
  assert.equal((await one(pool, 'SELECT status FROM invoices WHERE id=$1', [inv.id])).status, 'open')
  await act(shop, 'invoices', 'pay', { phone: phone('SN') }, inv.id)
  await settleAll()
  const paid = await one(pool, 'SELECT * FROM invoices WHERE id=$1', [inv.id])
  assert.equal(paid.status, 'paid'); assert.ok(paid.paid_at)
  await healthy(assert)
})

test('refunding an escrow is a money action: quote first, PIN to confirm', async () => {
  const payer = await user('SN', 'boutique', { fund: 50000 }), payee = await user('SN', 'seller')
  await act(payer, 'escrow', 'hold', { amount: '15000', phone: payee.phone, name: 'Seller', title: 'Commande annulée' })
  const e = await one(pool, 'SELECT * FROM escrows WHERE title=$1', ['Commande annulée'])
  const q = await quote(payee, 'escrow', 'refund', {}, e.id)
  assert.ok(q.intentId, 'a quote, not an immediate refund')
  assert.equal((await one(pool, 'SELECT status FROM escrows WHERE id=$1', [e.id])).status, 'held')
  await assert.rejects(engine.confirmIntent(payee.id, q.intentId, { pin: '0000', idem: idem() }))
  await engine.confirmIntent(payee.id, (await quote(payee, 'escrow', 'refund', {}, e.id)).intentId, { pin: '2580', idem: idem() })
  assert.equal(await bal(payer), 50000)
  await healthy(assert)
})

test('an artisan without the app can request funding for a held stage from the link', async () => {
  const builder = await user('FR', 'builder', { fund: 2000 })
  const artisanPhone = phone('MA')
  await act(builder, 'jobs', 'create', { title: 'Riad', country: 'MA', phone: artisanPhone, name: 'Hassan Benali', stage1: 'Fondations', amount1: '5000' })
  const job = await one(pool, 'SELECT * FROM jobs WHERE created_by=$1', [builder.id])
  const token = await linkFor('job', job.id, (await partyByPhone(artisanPhone)).id)
  const page = await (await fetch(`${base}/public/${token}`)).json()
  assert.ok(page.actions.some(a => a.id === 'request'))
  assert.equal((await linkAct(token, 'request')).status, 200)
  assert.equal((await one(pool, 'SELECT status FROM job_stages WHERE job_id=$1', [job.id])).status, 'requested')
  await act(builder, 'jobs', 'fund', {}, job.id)
  assert.equal((await one(pool, 'SELECT status FROM job_stages WHERE job_id=$1', [job.id])).status, 'funded')
})

test('errors: bad input gets a clear 4xx in French, never a 500', async () => {
  const sender = await user('FR', 'sender')
  await assert.rejects(engine.perform(sender.id, 'remit', 'send', { input: {}, idem: idem() }), e => e.status === 409 && /Ajoutez d’abord un proche/.test(e.message))
  const bad = await raw('/auth/otp', '{"phone":')
  assert.equal(bad.status, 400); assert.equal(bad.error, 'Requête invalide')
  const { createHmac } = await import('node:crypto'), { config } = await import('../config.js')
  const body = 'not json'
  const wh = await raw('/webhooks/provider', body, { 'x-signature': createHmac('sha256', config.partner.webhookSecret).update(body).digest('hex') })
  assert.equal(wh.status, 400)
  const admin = await user('FR', 'sender', { roles: ['admin'] })
  const jwt = (await import('jsonwebtoken')).default
  const sid = (await one(pool, `INSERT INTO sessions (id, user_id, refresh_hash) VALUES (gen_random_uuid(), $1, 'x') RETURNING id`, [admin.id])).id
  const token = jwt.sign({ sub: admin.id, sid, typ: 'access' }, config.jwtSecret, { expiresIn: '5m' })
  const r = await raw('/admin/disputes/00000000-0000-0000-0000-000000000000/propose', JSON.stringify({ outcome: 'refund', note: 'x' }), { Authorization: `Bearer ${token}` })
  assert.equal(r.status, 404)
})

test('an outbox job left "running" by a crashed worker is picked up again once its lease expires', async () => {
  const u = await user('SN', 'seller')
  await act(u, 'wallet', 'topup', { amount: '500' })
  await pool.query(`UPDATE outbox SET status='running', next_at = now() - interval '1 minute' WHERE status='pending'`)
  await settleAll()
  assert.equal(await bal(u), 500)
})

test('both sides of a dispute can add evidence, from the app or from a link; nobody else can', async () => {
  const jwt = (await import('jsonwebtoken')).default, { config } = await import('../config.js'), sharp = (await import('sharp')).default
  const bearer = async u => {
    const sid = (await one(pool, `INSERT INTO sessions (id, user_id, refresh_hash) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [u.id, idem()])).id
    return { Authorization: `Bearer ${jwt.sign({ sub: u.id, sid, typ: 'access' }, config.jwtSecret, { expiresIn: '5m' })}` }
  }
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c33' } }).png().toBuffer()
  const upload = async (path, headers = {}) => (await (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'image/png', ...headers }, body: png })).json()).id

  const payer = await user('SN', 'boutique', { fund: 50000 }), outsider = await user('SN', 'boutique')
  const payeePhone = phone('SN')
  await act(payer, 'escrow', 'hold', { amount: '20000', phone: payeePhone, name: 'Awa Sarr', title: 'Lot de wax' })
  const e = await one(pool, 'SELECT * FROM escrows WHERE title=$1', ['Lot de wax'])
  const token = await linkFor('escrow', e.id, e.payee_party)

  await assert.rejects(act(payer, 'escrow', 'evidence', { text: 'Trop tôt' }, e.id), /plus possible/, 'no evidence before a dispute exists')
  await act(payer, 'escrow', 'dispute', { reason: 'Tissu abîmé' }, e.id)
  const d = await one(pool, 'SELECT * FROM disputes WHERE escrow_id=$1', [e.id])

  // The payer, from the app: a statement and a photo they uploaded.
  const payerPhoto = await upload('/uploads', await bearer(payer))
  await act(payer, 'escrow', 'evidence', { text: 'Trois pièces sur dix sont déchirées', photo: payerPhoto }, e.id)
  await assert.rejects(act(payer, 'escrow', 'evidence', {}, e.id), /explication ou une photo/)

  // The payee has no app: photo and statement go through their link, behind a code sent to their phone.
  const payeePhoto = await upload(`/public/${token}/upload`)
  assert.equal((await linkAct(token, 'evidence', { text: 'Colis remis intact, photo à la livraison', photo: payeePhoto })).status, 200)
  assert.equal((await linkAct(token, 'evidence', { photo: payerPhoto })).status, 404, 'a photo uploaded by someone else cannot be attached')

  await assert.rejects(act(outsider, 'escrow', 'evidence', { text: 'Je passe par là' }, e.id), /Introuvable/)

  const rows = await pool.query('SELECT party_id, text, upload_id FROM dispute_evidence WHERE dispute_id=$1 ORDER BY created_at', [d.id])
  assert.deepEqual(rows.rows, [
    { party_id: e.payer_party, text: 'Trois pièces sur dix sont déchirées', upload_id: payerPhoto },
    { party_id: e.payee_party, text: 'Colis remis intact, photo à la livraison', upload_id: payeePhoto },
  ])
  // Each side's photo is visible to the other side and to nobody else.
  const see = async (u, id) => (await fetch(`${base}/uploads/${id}`, { headers: await bearer(u) })).status
  assert.equal(await see(payer, payeePhoto), 200)
  assert.equal(await see(outsider, payeePhoto), 404)

  await pool.query(`UPDATE disputes SET status='resolved' WHERE id=$1`, [d.id])
  await assert.rejects(act(payer, 'escrow', 'evidence', { text: 'Trop tard' }, e.id), /Aucun litige en cours/, 'a resolved dispute takes no more evidence')
})

test('a forgotten secret code is replaced after a login code; other sessions close and money waits 24 hours', async () => {
  const jwt = (await import('jsonwebtoken')).default, { config } = await import('../config.js')
  const post = (path, body, headers) => raw(path, JSON.stringify(body), headers)
  const u = await user('SN', 'boutique', { fund: 5000 })
  const oldSid = (await one(pool, `INSERT INTO sessions (id, user_id, refresh_hash) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [u.id, idem()])).id
  const oldAccess = { Authorization: `Bearer ${jwt.sign({ sub: u.id, sid: oldSid, typ: 'access' }, config.jwtSecret, { expiresIn: '5m' })}` }
  const me = headers => fetch(`${base}/me`, { headers }).then(r => r.status)
  assert.equal(await me(oldAccess), 200)

  assert.equal((await post('/auth/pin/reset', { pin: '7391' })).status, 401, 'no reset without a verified phone')
  const { sandboxCode } = await post('/auth/otp', { phone: u.phone })
  const { pinToken } = await post('/auth/verify', { phone: u.phone, code: sandboxCode })
  assert.equal((await post('/auth/pin/reset', { pinToken, pin: '1111' })).status, 400, 'obvious codes are still refused')
  const reset = await post('/auth/pin/reset', { pinToken, pin: '7391' })
  assert.equal(reset.status, 200)
  assert.equal(reset.holdHours, 24)

  assert.equal(await me(oldAccess), 401, 'sessions opened before the reset are closed')
  assert.equal(await me({ Authorization: `Bearer ${reset.accessToken}` }), 200)
  assert.equal((await one(pool, `SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND template='pin.reset'`, [u.id])).n, 1, 'the owner is told')

  await assert.rejects(act(u, 'wallet', 'topup', { amount: '500' }), /Code secret incorrect|incorrect/i, 'the old code no longer works')
  await assert.rejects(act(u, 'wallet', 'topup', { amount: '500' }, null, { pin: '7391' }), /suspendus/, 'money actions wait during the hold')
  await pool.query(`UPDATE users SET pin_reset_at = now() - interval '25 hours' WHERE id=$1`, [u.id])
  await act(u, 'wallet', 'topup', { amount: '500' }, null, { pin: '7391' })
  await settleAll()
  assert.equal(await bal(u), 5500)
})

test('a shared link carries a preview that says what it is, without names or amounts', { skip: !(await import('node:fs')).existsSync(new URL('../../dist/index.html', import.meta.url)) && 'needs the built page: npm run build' }, async () => {
  const artisan = await user('MA', 'maallem')
  const clientPhone = phone('MA')
  await act(artisan, 'jobs', 'create', { title: 'Salon marocain', phone: clientPhone, name: 'Nadia Alaoui', stage1: 'Zellige', amount1: '7000' })
  const job = await one(pool, 'SELECT * FROM jobs WHERE title=$1', ['Salon marocain'])
  const token = await linkFor('job', job.id, (await partyByPhone(clientPhone)).id)
  const origin = base.replace('/api', '')
  const html = await (await fetch(`${origin}/l/${token}`)).text()
  assert.match(html, /<meta property="og:title" content="Votre chantier : suivez et validez chaque étape" \/>/)
  assert.match(html, /<meta property="og:image" content="[^"]+\/icon-512\.png" \/>/)
  assert.match(html, /<div id="root">/, 'it is still the app page')
  for (const secret of ['Salon marocain', 'Nadia', '7000', '7 000']) assert.ok(!html.includes(secret), `the preview does not reveal "${secret}"`)
  assert.equal((await one(pool, 'SELECT opens FROM links WHERE party_id=$1 ORDER BY created_at DESC LIMIT 1', [(await partyByPhone(clientPhone)).id])).opens, 0, 'drawing the preview is not counted as opening the link')
  const unknown = await (await fetch(`${origin}/l/not-a-real-token`)).text()
  assert.match(unknown, /<meta property="og:title" content="Nexus" \/>/)
})

const bearerFor = async u => {
  const jwt = (await import('jsonwebtoken')).default, { config } = await import('../config.js')
  const sid = (await one(pool, `INSERT INTO sessions (id, user_id, refresh_hash) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [u.id, idem()])).id
  return { Authorization: `Bearer ${jwt.sign({ sub: u.id, sid, typ: 'access' }, config.jwtSecret, { expiresIn: '5m' })}` }
}

test('an admin can cut every link sent to a number; the cut is audited', async () => {
  const artisan = await user('MA', 'maallem'), admin = await user('FR', 'sender', { roles: ['admin'] })
  const clientPhone = phone('MA')
  await act(artisan, 'jobs', 'create', { title: 'Hammam', phone: clientPhone, name: 'Client Égaré', stage1: 'Tadelakt', amount1: '900' })
  const job = await one(pool, 'SELECT * FROM jobs WHERE title=$1', ['Hammam'])
  const token = await linkFor('job', job.id, (await partyByPhone(clientPhone)).id)
  assert.equal((await fetch(`${base}/public/${token}`)).status, 200)

  assert.equal((await raw('/admin/links/revoke', JSON.stringify({ phone: clientPhone, reason: 'x' }), await bearerFor(artisan))).status, 403, 'not for ordinary users')
  assert.equal((await raw('/admin/links/revoke', JSON.stringify({ phone: clientPhone }), await bearerFor(admin))).status, 400, 'a reason is required')
  const r = await raw('/admin/links/revoke', JSON.stringify({ phone: clientPhone, reason: 'Lien transféré par erreur' }), await bearerFor(admin))
  assert.equal(r.status, 200)
  assert.ok(r.revoked >= 2, 'the link sent at creation and the one re-sent')
  assert.equal((await fetch(`${base}/public/${token}`)).status, 404)
  assert.ok(await one(pool, `SELECT 1 FROM audit_events WHERE action='links.revoke' AND actor_id=$1`, [admin.id]))
  assert.equal((await fetch(`${base}/public/${await linkFor('job', job.id, (await partyByPhone(clientPhone)).id)}`)).status, 200, 'a fresh link works')
})

test('admin exports are CSV files, limited to admins, audited, and safe to open in a spreadsheet', async () => {
  const admin = await user('FR', 'sender', { roles: ['admin'] }), seller = await user('MA', 'seller')
  await pool.query(`UPDATE users SET name='=HYPERLINK("http://evil.test";"Cliquez")' WHERE id=$1`, [seller.id])
  const get = async (path, u) => { const r = await fetch(base + path, { headers: await bearerFor(u) }); return { status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), text: await r.text() } }
  assert.equal((await get('/admin/export/users', seller)).status, 403)
  assert.equal((await get('/admin/export/passwords', admin)).status, 404)
  const users = await get('/admin/export/users', admin)
  assert.equal(users.status, 200)
  assert.match(users.type, /text\/csv/)
  assert.match(users.disposition, /attachment; filename="nexus-users-\d{4}-\d{2}-\d{2}\.csv"/)
  const lines = users.text.replace(/^﻿/, '').trim().split('\r\n')
  assert.match(lines[0], /^id,phone,name,region,persona,kyc_level,frozen,created_at/)
  assert.ok(!users.text.includes('pin_hash'), 'no secret column')
  const row = lines.find(l => l.includes(seller.phone))
  assert.ok(row.includes(`"'=HYPERLINK(""http://evil.test"";""Cliquez"")"`), 'a cell starting with = is neutralised and quoted')
  assert.equal((await get('/admin/export/users?from=2000-01-01&to=2000-12-31', admin)).text.replace(/^﻿/, ''), '', 'the date range is applied')
  assert.equal((await get('/admin/export/ledger', admin)).status, 200)
  assert.equal((await one(pool, `SELECT count(*)::int AS n FROM audit_events WHERE action='export' AND actor_id=$1`, [admin.id])).n, 3)
})

test('a person can download their own data and ask for their account to be closed', async () => {
  const artisan = await user('MA', 'maallem'), other = await user('MA', 'maallem'), admin = await user('FR', 'sender', { roles: ['admin'] })
  await act(artisan, 'jobs', 'create', { title: 'Mon chantier à moi', phone: phone('MA'), name: 'Cliente', stage1: 'Peinture', amount1: '400' })
  await act(other, 'jobs', 'create', { title: 'Chantier d’un autre', phone: phone('MA'), name: 'Client', stage1: 'Carrelage', amount1: '800' })
  const r = await fetch(`${base}/me/export`, { headers: await bearerFor(artisan) })
  assert.equal(r.status, 200)
  const data = await r.json()
  assert.equal(data.account.phone, artisan.phone)
  assert.deepEqual(data.jobs.map(j => [j.title, j.role, j.stages[0].title]), [['Mon chantier à moi', 'artisan', 'Peinture']])
  const text = JSON.stringify(data)
  assert.ok(!text.includes('Chantier d’un autre') && !text.includes('pin_hash'), 'nothing of anyone else, no secret')
  assert.equal((await fetch(`${base}/me/export`)).status, 401)

  const closure = await raw('/me/closure', '{}', await bearerFor(artisan))
  assert.equal(closure.status, 200)
  await raw('/me/closure', '{}', await bearerFor(artisan))
  assert.ok((await one(pool, 'SELECT closure_requested_at FROM users WHERE id=$1', [artisan.id])).closure_requested_at)
  assert.equal((await one(pool, `SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND template='alert.closure'`, [admin.id])).n, 1, 'admins are told once')
})
