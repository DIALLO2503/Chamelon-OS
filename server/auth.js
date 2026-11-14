import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { randomInt, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { pool, tx, one } from './db.js'
import { config } from './config.js'
import { fail, newId, sha256, normalizePhone } from './core.js'
import { REGIONS, personaExists } from './catalog.js'
import { audit, partyForUser } from './context.js'
import { log } from './log.js'
import { smsConfigured, sendSms } from './messaging.js'

const OTP_TTL_MIN = 5
const CAPS = config.sandbox && config.env !== 'test'
  ? { sendsPerDay: 50, failsPerDay: 50 }
  : { sendsPerDay: 5, failsPerDay: 10 }
const PIN_MAX_FAILURES = 5
const ACCESS_TTL = '15m'
const REFRESH_DAYS = 30
const COOKIE = 'nexus_rt'

const otpHash = (phone, code) => sha256(`${phone}:${code}:${config.jwtSecret}`)
const fullPhone = raw => (String(raw ?? '').trim().startsWith('+') ? normalizePhone(raw) : fail("Indiquez le numéro avec l'indicatif du pays"))
const signPurpose = (purpose, data, ttl) => jwt.sign({ purpose, ...data }, config.jwtSecret, { expiresIn: ttl })
function readPurpose(token, purpose) {
  try {
    const p = jwt.verify(String(token ?? ''), config.jwtSecret)
    if (p.purpose !== purpose) throw new Error('wrong purpose')
    return p
  } catch { fail('Vérification expirée, recommencez', 401) }
}

/* ---------------- PIN ---------------- */

export function hashPin(pin) {
  if (!/^\d{4,6}$/.test(String(pin ?? ''))) fail('Le code secret doit faire 4 à 6 chiffres')
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) fail('Choisissez un code secret moins évident')
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(String(pin), salt, 32).toString('hex')}`
}

// Checks a user's PIN with lockout. Runs in its own transaction so failures are counted even if the caller rolls back.
export async function verifyPin(userId, pin) {
  return tx(async c => {
    const u = await one(c, 'SELECT pin_hash, pin_failures, pin_locked_until FROM users WHERE id=$1 FOR UPDATE', [userId])
    if (!u.pin_hash) fail('Définissez d’abord votre code secret', 403)
    if (u.pin_locked_until && new Date(u.pin_locked_until) > new Date()) fail('Code secret bloqué pour 15 minutes après plusieurs erreurs', 423)
    const [salt, hash] = u.pin_hash.split(':')
    const ok = timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(String(pin ?? ''), salt, 32))
    if (ok) { await c.query('UPDATE users SET pin_failures=0, pin_locked_until=NULL WHERE id=$1', [userId]); return }
    const failures = u.pin_failures + 1
    await c.query(`UPDATE users SET pin_failures=$2::int, pin_locked_until=CASE WHEN $2::int >= $3::int THEN now() + interval '15 minutes' END WHERE id=$1`, [userId, failures, PIN_MAX_FAILURES])
    await audit(c, { actorId: userId, action: 'pin.failed' })
    return { failed: true }
  }).then(r => { if (r?.failed) fail('Code secret incorrect', 401) })
}

/* ---------------- sessions ---------------- */

// A login code alone proves the SIM, not the person: after a reset, money actions wait, so a stolen phone or a swapped
// SIM cannot empty the account before its owner has it frozen.
export async function assertNoPinHold(userId) {
  const u = await one(pool, `SELECT pin_reset_at + make_interval(hours => $2) AS until FROM users WHERE id=$1`, [userId, config.pinResetHoldHours])
  if (u?.until && new Date(u.until) > new Date()) {
    const when = new Date(u.until).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
    fail(`Par sécurité, les paiements sont suspendus après un changement de code secret. Ils reprennent le ${when} UTC.`, 423)
  }
}

async function openSession(c, user, req, res) {
  const sid = newId(), refresh = randomBytes(32).toString('base64url')
  await c.query('INSERT INTO sessions (id, user_id, refresh_hash, user_agent) VALUES ($1,$2,$3,$4)', [sid, user.id, sha256(refresh), String(req.get('user-agent') ?? '').slice(0, 200)])
  await audit(c, { actorId: user.id, action: 'session.open', objectType: 'session', objectId: sid, ip: req.ip })
  setRefreshCookie(res, `${sid}.${refresh}`)
  return { accessToken: jwt.sign({ sub: user.id, sid, typ: 'access' }, config.jwtSecret, { expiresIn: ACCESS_TTL }) }
}
function setRefreshCookie(res, value) {
  const attrs = [`${COOKIE}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/api/auth', `Max-Age=${value ? REFRESH_DAYS * 86400 : 0}`]
  if (config.env === 'live') attrs.push('Secure')
  res.setHeader('Set-Cookie', attrs.join('; '))
}
const readCookie = req => Object.fromEntries(String(req.headers.cookie ?? '').split(';').map(p => p.trim().split('=')).filter(p => p[0]))[COOKIE]

export async function requireAuth(req, res, next) {
  try {
    const p = jwt.verify(req.headers.authorization?.split(' ')[1] ?? '', config.jwtSecret)
    if (p.typ !== 'access') throw new Error('not an access token')
    const s = await one(pool, 'SELECT s.revoked_at, u.frozen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id=$1 AND s.user_id=$2', [p.sid, p.sub])
    if (!s || s.revoked_at) throw new Error('session revoked')
    if (s.frozen && req.method !== 'GET') return res.status(403).json({ error: 'Ce compte est suspendu. Contactez l’assistance.' })
    req.userId = p.sub
    req.sessionId = p.sid
    next()
  } catch { res.status(401).json({ error: 'Session expirée, reconnectez-vous' }) }
}

export const requireRole = role => async (req, res, next) => {
  const r = await one(pool, `SELECT 1 FROM roles WHERE user_id=$1 AND role=$2 AND status='active'`, [req.userId, role])
  if (!r) return res.status(403).json({ error: 'Accès réservé' })
  next()
}

/* ---------------- routes ---------------- */

export const auth = Router()

// Issues a one-time code for a phone, within daily caps. Returns the code (the caller decides whether to reveal it in sandbox).
export async function issueOtp(phone, ip) {
  const counts = await one(pool, `SELECT count(*) FILTER (WHERE kind='send')::int AS sends, count(*) FILTER (WHERE kind='fail')::int AS fails
    FROM otp_events WHERE phone=$1 AND created_at > now() - interval '1 day'`, [phone])
  if (counts.sends >= CAPS.sendsPerDay || counts.fails >= CAPS.failsPerDay) fail('Trop de demandes pour ce numéro aujourd’hui. Réessayez demain.', 429)
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  await tx(async c => {
    await c.query(`INSERT INTO otps (phone, hash, expires_at, attempts) VALUES ($1,$2, now() + make_interval(mins => $3), 0)
      ON CONFLICT (phone) DO UPDATE SET hash=EXCLUDED.hash, expires_at=EXCLUDED.expires_at, attempts=0`, [phone, otpHash(phone, code), OTP_TTL_MIN])
    await c.query(`INSERT INTO otp_events (phone, kind, ip) VALUES ($1,'send',$2)`, [phone, ip])
  })
  // The code goes out by SMS whenever a provider is configured (config.js refuses to boot live without one).
  // The send counts against the daily cap even if delivery fails, so a failing provider cannot be used to probe for free.
  if (smsConfigured()) {
    try {
      await sendSms(phone, `Nexus : votre code est ${code}. Il expire dans ${OTP_TTL_MIN} minutes. Ne le partagez avec personne.`)
    } catch (e) {
      log.error({ phone, err: e.message }, 'otp sms failed')
      fail('Impossible d’envoyer le code pour le moment. Réessayez dans un instant.', 502)
    }
  }
  if (!config.sandbox) log.info({ phone }, 'otp issued')
  // Outside live the code is also returned to the caller, which shows it on screen.
  return config.sandbox ? code : null
}

// Checks and consumes a code. Failures are counted per phone over 24 h, not per code, so re-sending does not reset them.
export async function consumeOtp(phone, code, ip) {
  const result = await tx(async c => {
    const otp = await one(c, 'SELECT * FROM otps WHERE phone=$1 FOR UPDATE', [phone])
    if (!otp || new Date(otp.expires_at) < new Date()) return ['Code expiré, demandez-en un nouveau', 401]
    if (otp.attempts >= 5) return ['Trop d’essais, demandez un nouveau code', 429]
    if (otp.hash !== otpHash(phone, String(code ?? ''))) {
      await c.query('UPDATE otps SET attempts = attempts + 1 WHERE phone=$1', [phone])
      await c.query(`INSERT INTO otp_events (phone, kind, ip) VALUES ($1,'fail',$2)`, [phone, ip])
      return ['Code incorrect', 401]
    }
    await c.query('DELETE FROM otps WHERE phone=$1', [phone])
    return null
  })
  if (result) fail(...result)
}

auth.post('/otp', async (req, res) => {
  const code = await issueOtp(fullPhone(req.body?.phone), req.ip)
  res.json({ ok: true, ...(code ? { sandboxCode: code } : {}) })
})

auth.post('/verify', async (req, res) => {
  const phone = fullPhone(req.body?.phone)
  await consumeOtp(phone, req.body?.code, req.ip)
  const user = await one(pool, 'SELECT * FROM users WHERE phone=$1', [phone])
  if (!user) return res.json({ signupToken: signPurpose('signup', { phone }, '15m') })
  // A new device needs both the phone (code just verified) and the PIN.
  res.json({ pinToken: signPurpose('login', { sub: user.id }, '5m'), name: user.name })
})

auth.post('/pin', async (req, res) => {
  const { sub } = readPurpose(req.body?.pinToken, 'login')
  await verifyPin(sub, req.body?.pin)
  const out = await tx(async c => openSession(c, await one(c, 'SELECT * FROM users WHERE id=$1', [sub]), req, res))
  res.json(out)
})

// Forgotten secret code: the phone was just verified by a login code (that is what the pinToken proves).
// Sets a new code, closes every other session, tells the owner, and starts the money hold.
auth.post('/pin/reset', async (req, res) => {
  const { sub } = readPurpose(req.body?.pinToken, 'login')
  const pinHash = hashPin(String(req.body?.pin ?? ''))
  const out = await tx(async c => {
    const user = await one(c, 'SELECT * FROM users WHERE id=$1 FOR UPDATE', [sub])
    if (user.frozen) fail('Ce compte est suspendu. Contactez l’assistance.', 403)
    await c.query('UPDATE users SET pin_hash=$2, pin_failures=0, pin_locked_until=NULL, pin_reset_at=now() WHERE id=$1', [sub, pinHash])
    await c.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [sub])
    await audit(c, { actorId: sub, action: 'pin.reset', objectType: 'user', objectId: sub, ip: req.ip })
    await c.query(`INSERT INTO notifications (user_id, channel, template, text, status) VALUES ($1,'inapp','pin.reset',$2,'delivered')`,
      [sub, `Votre code secret a été changé. Les paiements sont suspendus ${config.pinResetHoldHours} h par sécurité. Si ce n’est pas vous, contactez l’assistance immédiatement.`])
    return openSession(c, user, req, res)
  })
  res.json({ ...out, holdHours: config.pinResetHoldHours })
})

auth.post('/register', async (req, res) => {
  const { phone } = readPurpose(req.body?.signupToken, 'signup')
  const { name, region, persona, pin } = req.body ?? {}
  const clean = String(name ?? '').trim()
  if (clean.length < 2 || clean.length > 60) fail('Indiquez votre nom')
  if (!personaExists(region, persona)) fail('Profil indisponible dans ce pays')
  if (!phone.startsWith(REGIONS[region].dialCode)) fail(`Pour un compte en ${REGIONS[region].name}, utilisez un numéro ${REGIONS[region].dialCode}`)
  const pinHash = hashPin(String(pin ?? ''))
  const out = await tx(async c => {
    if (await one(c, 'SELECT 1 FROM users WHERE phone=$1', [phone])) fail('Un compte existe déjà pour ce numéro', 409)
    const user = await createUser(c, { phone, name: clean, region, persona, pinHash })
    return openSession(c, user, req, res)
  })
  res.json(out)
})

auth.post('/refresh', async (req, res) => {
  const [sid, token] = String(readCookie(req) ?? '').split('.')
  const out = await tx(async c => {
    const s = sid && await one(c, 'SELECT * FROM sessions WHERE id=$1 FOR UPDATE', [sid])
    if (!s || s.revoked_at || s.refresh_hash !== sha256(token ?? '')) return null
    if (Date.now() - new Date(s.created_at).getTime() > REFRESH_DAYS * 86400000) return null
    const next = randomBytes(32).toString('base64url')
    await c.query('UPDATE sessions SET refresh_hash=$2, last_used_at=now() WHERE id=$1', [sid, sha256(next)])
    setRefreshCookie(res, `${sid}.${next}`)
    return { accessToken: jwt.sign({ sub: s.user_id, sid, typ: 'access' }, config.jwtSecret, { expiresIn: ACCESS_TTL }) }
  })
  if (!out) { setRefreshCookie(res, ''); fail('Session expirée, reconnectez-vous', 401) }
  res.json(out)
})

auth.post('/logout', async (req, res) => {
  const [sid] = String(readCookie(req) ?? '').split('.')
  if (sid) await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [sid])
  setRefreshCookie(res, '')
  res.json({ ok: true })
})

export async function createUser(c, { phone, name, region, persona, pinHash = null, kycLevel = 0, createdAt = null }) {
  const id = newId()
  await c.query('INSERT INTO users (id, phone, name, region, persona, pin_hash, kyc_level, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, now()))',
    [id, phone, name, region, persona, pinHash, kycLevel, createdAt])
  const restricted = REGIONS[region].personas[persona].restricted
  if (restricted) await c.query(`INSERT INTO roles (user_id, role, status) VALUES ($1,$2,'pending')`, [id, restricted])
  const user = await one(c, 'SELECT * FROM users WHERE id=$1', [id])
  await partyForUser(c, user)
  await audit(c, { actorId: id, action: 'user.create', objectType: 'user', objectId: id, data: { region, persona } })
  return user
}
