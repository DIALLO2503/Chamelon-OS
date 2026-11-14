// SMS login codes and WhatsApp/SMS notifications, against a local stand-in for Twilio's Messages API.
// The stand-in must be listening before config.js is imported, because the base URL is read once at import.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const SID = 'ACtest0000000000000000000000000000', TOKEN = 'test-auth-token'
const sent = []
let failNext = null
const twilio = http.createServer((req, res) => {
  let raw = ''
  req.on('data', d => { raw += d })
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json')
    if (failNext) { const f = failNext; failNext = null; res.statusCode = f.status; return res.end(JSON.stringify(f.body)) }
    sent.push({ path: req.url, auth: req.headers.authorization, form: Object.fromEntries(new URLSearchParams(raw)) })
    res.statusCode = 201
    res.end(JSON.stringify({ sid: `SM${sent.length}` }))
  })
})
await new Promise(r => twilio.listen(0, r))

Object.assign(process.env, {
  SMS_PROVIDER: 'twilio', SMS_API_KEY: TOKEN, TWILIO_ACCOUNT_SID: SID, SMS_FROM: 'Nexus',
  TWILIO_BASE_URL: `http://localhost:${twilio.address().port}`,
  NOTIFIER: 'whatsapp', WHATSAPP_FROM: '+14155238886', WHATSAPP_TEMPLATES: JSON.stringify({ 'escrow.request': 'HXescrowrequest' }),
})
const { pool, one, tx, resetDb, rails, phone } = await import('./helpers.js')
const { partyByPhone } = await import('../context.js')

let server, base
before(async () => {
  await resetDb()
  const { app } = await import('../index.js')
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://localhost:${server.address().port}/api`
})
after(async () => { server.close(); twilio.close(); await pool.end() })
beforeEach(() => { sent.length = 0; failNext = null })

const requestOtp = async p => {
  const r = await fetch(`${base}/auth/otp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: p }) })
  return { status: r.status, ...(await r.json()) }
}
// A notification to someone without an account, as a module would write it; returns its id.
async function notifyStranger(template, link = 'https://nexus.test/l/abc') {
  const p = phone('SN')
  const id = await tx(async c => {
    const party = await partyByPhone(c, p, 'Awa Ndiaye')
    await rails.notify(c, { partyId: party.id, template, text: 'Fatou D. vous demande 5 000 F', link })
    return (await one(c, 'SELECT id FROM notifications WHERE party_id=$1', [party.id])).id
  })
  return { id, phone: p }
}

test('a login code is sent by SMS through the provider, with the account credentials', async () => {
  const p = phone('MA')
  const r = await requestOtp(p)
  assert.equal(r.status, 200)
  assert.equal(sent.length, 1)
  const [m] = sent
  assert.equal(m.path, `/2010-04-01/Accounts/${SID}/Messages.json`)
  assert.equal(m.auth, `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`)
  assert.equal(m.form.To, p)
  assert.equal(m.form.From, 'Nexus')
  assert.match(m.form.Body, new RegExp(`\\b${r.sandboxCode}\\b`), 'the SMS carries the code that was stored')
})

test('a provider failure is reported to the caller and still counts against the daily cap', async () => {
  const p = phone('MA')
  failNext = { status: 400, body: { code: 21211, message: 'Invalid To number' } }
  const r = await requestOtp(p)
  assert.equal(r.status, 502)
  assert.equal(r.sandboxCode, undefined, 'no code is revealed when it could not be sent')
  assert.equal((await one(pool, `SELECT count(*)::int AS n FROM otp_events WHERE phone=$1 AND kind='send'`, [p])).n, 1)
})

test('a notification with an approved template goes out on WhatsApp', async () => {
  const n = await notifyStranger('escrow.request')
  await rails.drainOutbox()
  assert.equal(sent.length, 1)
  const { form } = sent[0]
  assert.equal(form.To, `whatsapp:${n.phone}`)
  assert.equal(form.From, 'whatsapp:+14155238886')
  assert.equal(form.ContentSid, 'HXescrowrequest')
  assert.deepEqual(JSON.parse(form.ContentVariables), { 1: 'Fatou D. vous demande 5 000 F', 2: 'https://nexus.test/l/abc' })
  assert.deepEqual(await one(pool, 'SELECT status, channel FROM notifications WHERE id=$1', [n.id]), { status: 'sent', channel: 'whatsapp' })
})

test('a notification without an approved template falls back to SMS, link included', async () => {
  const n = await notifyStranger('tontine.invite')
  await rails.drainOutbox()
  assert.equal(sent.length, 1)
  const { form } = sent[0]
  assert.equal(form.To, n.phone)
  assert.equal(form.From, 'Nexus')
  assert.equal(form.Body, 'Fatou D. vous demande 5 000 F\nhttps://nexus.test/l/abc')
  assert.deepEqual(await one(pool, 'SELECT status, channel FROM notifications WHERE id=$1', [n.id]), { status: 'sent', channel: 'sms' })
})

test('a failed delivery stays pending in the outbox and is sent on retry', async () => {
  const n = await notifyStranger('escrow.request')
  failNext = { status: 503, body: { message: 'Service unavailable' } }
  await rails.drainOutbox()
  assert.equal(sent.length, 0)
  const job = await one(pool, `SELECT status, last_error FROM outbox WHERE idem=$1`, [`notify:${n.id}`])
  assert.equal(job.status, 'pending')
  assert.match(job.last_error, /Twilio 503/)
  assert.equal((await one(pool, 'SELECT status FROM notifications WHERE id=$1', [n.id])).status, 'pending')

  await pool.query(`UPDATE outbox SET next_at=now() WHERE idem=$1`, [`notify:${n.id}`])
  await rails.drainOutbox()
  assert.equal(sent.length, 1)
  assert.equal((await one(pool, 'SELECT status FROM notifications WHERE id=$1', [n.id])).status, 'sent')
})
