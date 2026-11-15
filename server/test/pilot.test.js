// A two-country "record" pilot: sign-up open in Morocco and Guinea only, login codes sent by one Android phone per
// country (SMS Gateway for Android), no payment partner. The gateway is a local stand-in, listening before config loads.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

const sent = []
const gateway = http.createServer((req, res) => {
  let raw = ''
  req.on('data', d => { raw += d })
  req.on('end', () => {
    const [user, password] = Buffer.from(String(req.headers.authorization).replace('Basic ', ''), 'base64').toString().split(':')
    sent.push({ path: req.url, user, password, body: JSON.parse(raw) })
    res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: `msg${sent.length}`, state: 'Pending' }))
  })
})
await new Promise(r => gateway.listen(0, r))

const PILOT = {
  SIGNUP_REGIONS: 'MA,GN', SMS_PROVIDER: 'smsgate', NOTIFIER: 'sms', SMSGATE_BASE_URL: `http://localhost:${gateway.address().port}/3rdparty/v1`,
  SMSGATE_MA_USER: 'MAPHONE', SMSGATE_MA_PASSWORD: 'ma-secret', SMSGATE_GN_USER: 'GNPHONE', SMSGATE_GN_PASSWORD: 'gn-secret',
}
Object.assign(process.env, PILOT)
const { pool, one, tx, resetDb, rails, phone, user, act, linkFor, partyByPhone: partyRow } = await import('./helpers.js')
const { partyByPhone } = await import('../context.js')

let server, base
before(async () => {
  await resetDb()
  const { app } = await import('../index.js')
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://localhost:${server.address().port}/api`
})
after(async () => { server.close(); gateway.close(); await pool.end() })
beforeEach(() => { sent.length = 0 })

const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, ...(await r.json()) }
}

test('each country sends its login codes from its own phone', async () => {
  const ma = phone('MA'), gn = phone('GN')
  const r = await post('/auth/otp', { phone: ma })
  await post('/auth/otp', { phone: gn })
  assert.deepEqual(sent.map(m => [m.path, m.user, m.password, m.body.phoneNumbers]), [
    ['/3rdparty/v1/message', 'MAPHONE', 'ma-secret', [ma]],
    ['/3rdparty/v1/message', 'GNPHONE', 'gn-secret', [gn]],
  ])
  assert.match(sent[0].body.textMessage.text, new RegExp(`\\b${r.sandboxCode}\\b`))
  assert.equal((await post('/auth/otp', { phone: phone('SN') })).status, 502, 'a country with no phone cannot receive a code')
})

test('sign-up is offered and accepted only in the pilot countries', async () => {
  const { regions } = await (await fetch(`${base}/config/regions`)).json()
  assert.deepEqual(regions.map(r => r.id), ['MA', 'GN'])
  const signup = async (p, region, persona) => {
    const { sandboxCode } = await post('/auth/otp', { phone: p })
    const { signupToken } = await post('/auth/verify', { phone: p, code: sandboxCode })
    return post('/auth/register', { signupToken, name: 'Test Pilote', region, persona, pin: '4826', terms: true })
  }
  assert.equal((await signup(phone('GN'), 'GN', 'artisan')).status, 200)
  const closed = await signup(phone('MA'), 'SN', 'driver')
  assert.equal(closed.status, 400)
  assert.match(closed.error, /indisponible/)
})

test('people without the app are notified by SMS from the phone of their country', async () => {
  const p = phone('GN')
  await tx(async c => rails.notify(c, { partyId: (await partyByPhone(c, p, 'Mamadou Bah')).id, template: 'recorded.claim', text: 'Sékou C. a signalé un paiement de 50 000 GNF', link: 'https://nexus.test/l/xyz' }))
  await rails.drainOutbox()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].user, 'GNPHONE')
  assert.deepEqual(sent[0].body, { textMessage: { text: 'Sékou C. a signalé un paiement de 50 000 GNF\nhttps://nexus.test/l/xyz' }, phoneNumbers: [p] })
  assert.equal((await one(pool, 'SELECT channel FROM notifications WHERE party_id IS NOT NULL ORDER BY id DESC LIMIT 1')).channel, 'sms')
})

test('the first admin is created from the command line and chooses a secret code at first sign-in', async () => {
  const p = phone('MA')
  execFileSync(process.execPath, ['server/cli/create-admin.js', p, 'Admin Pilote'], { env: { ...process.env, NEXUS_ENV: 'test' }, stdio: 'pipe' })
  const { sandboxCode } = await post('/auth/otp', { phone: p })
  const { pinToken, name } = await post('/auth/verify', { phone: p, code: sandboxCode })
  assert.equal(name, 'Admin Pilote')
  assert.equal((await post('/auth/pin', { pinToken, pin: '4826', terms: true })).status, 403, 'no secret code yet')
  const { accessToken } = await post('/auth/pin/reset', { pinToken, pin: '4826', terms: true })
  const overview = await fetch(`${base}/admin/overview`, { headers: { Authorization: `Bearer ${accessToken}` } })
  assert.equal(overview.status, 200)
})

test('live boots without a payment partner only when every open country is in "record" custody', () => {
  const boot = extra => {
    const env = { PATH: process.env.PATH, NEXUS_ENV: 'live', DATABASE_URL: 'postgres://unused', JWT_SECRET: 'a', LINK_SECRET: 'b', PAYMENT_PROVIDER: 'none', ...PILOT, ...extra }
    try { execFileSync(process.execPath, ['--input-type=module', '-e', `await import('./server/config.js')`], { env, stdio: 'pipe' }); return 'boots' } catch (e) { return String(e.stderr).match(/Error: (.*)/)?.[1] ?? 'failed' }
  }
  assert.equal(boot({}), 'boots')
  assert.match(boot({ SIGNUP_REGIONS: 'MA,GN,SN' }), /SN hold funds/)
  assert.equal(boot({ SIGNUP_REGIONS: 'MA,GN,SN', CUSTODY_SN: 'record', SMSGATE_USER: 'ANY', SMSGATE_PASSWORD: 'x' }), 'boots')
  assert.match(boot({ SMSGATE_GN_USER: '', SMSGATE_GN_PASSWORD: '' }), /missing: GN/)
  assert.match(boot({ PAYMENT_PROVIDER: 'sandbox' }), /requires PAYMENT_PROVIDER=partner/)
  assert.match(boot({ ADVANCE_LENDER: 'Some lender' }), /ADVANCE_LENDER requires PAYMENT_PROVIDER=partner/, 'no advances without a partner to pay them through')
})

test('the funnel counts who opened a link, who acted on it and who signed up afterwards, once per person', async () => {
  const { linkFunnel } = await import('../admin.js')
  const artisan = await user('MA', 'maallem')
  const invite = async title => {
    const p = phone('MA')
    await act(artisan, 'jobs', 'create', { title, phone: p, name: 'Cliente Pilote', stage1: 'Pose', amount1: '1500' })
    const job = await one(pool, 'SELECT * FROM jobs WHERE title=$1', [title])
    return { p, job, token: await linkFor('job', job.id, (await partyRow(p)).id) }
  }
  const engaged = await invite('Cuisine'), silent = await invite('Terrasse')
  await linkFor('job', silent.job.id, (await partyRow(silent.p)).id) // the same link sent again: still one invitation

  await act(artisan, 'jobs', 'done', {}, engaged.job.id)
  assert.equal((await fetch(`${base}/public/${engaged.token}`)).status, 200)
  const { sandboxCode } = await post(`/public/${engaged.token}/otp`, {})
  assert.equal((await post(`/public/${engaged.token}/act`, { action: 'validate', code: sandboxCode })).status, 200)
  // The client then opens an account with the same number.
  const otp = await post('/auth/otp', { phone: engaged.p })
  const { signupToken } = await post('/auth/verify', { phone: engaged.p, code: otp.sandboxCode })
  assert.equal((await post('/auth/register', { signupToken, name: 'Cliente Pilote', region: 'MA', persona: 'parent', pin: '4826', terms: true })).status, 200)

  const row = (await linkFunnel()).find(r => r.region === 'MA' && r.kind === 'job')
  assert.deepEqual({ sent: row.sent, opened: row.opened, acted: row.acted, signed_up: row.signed_up, openRate: row.openRate }, { sent: 2, opened: 1, acted: 1, signed_up: 1, openRate: 50 })
})
