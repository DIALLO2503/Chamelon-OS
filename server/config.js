import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REGIONS, openRegionIds } from './catalog.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = process.env

// Fail closed: the environment must be named explicitly, and anything that is not "sandbox" or "test" is live.
const NEXUS_ENV = env.NEXUS_ENV
if (!['sandbox', 'live', 'test'].includes(NEXUS_ENV)) {
  throw new Error('NEXUS_ENV must be set to "sandbox", "live" or "test"')
}

function secret(name, devFile) {
  if (env[name]) return env[name]
  if (NEXUS_ENV === 'live') throw new Error(`${name} is required in live mode`)
  const file = path.join(root, '.local', devFile)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(48).toString('hex'), { mode: 0o600 })
  return fs.readFileSync(file, 'utf8')
}

function jsonEnv(name) {
  if (!env[name]) return {}
  try {
    const v = JSON.parse(env[name])
    if (v && typeof v === 'object' && !Array.isArray(v)) return v
  } catch { /* reported below */ }
  throw new Error(`${name} must be a JSON object`)
}

function gateway(prefix) {
  const user = env[`${prefix}_USER`], password = env[`${prefix}_PASSWORD`]
  if (!user && !password) return null
  if (!user || !password) throw new Error(`${prefix}_USER and ${prefix}_PASSWORD must be set together`)
  // A phone on the server's own network can be reached directly (the app's local mode), so its codes never leave it.
  return { user, password, url: env[`${prefix}_URL`]?.replace(/\/$/, '') }
}

export const config = {
  env: NEXUS_ENV,
  sandbox: NEXUS_ENV !== 'live',
  port: Number(env.PORT || 3001),
  databaseUrl: env.DATABASE_URL || (NEXUS_ENV === 'test' ? 'postgres://nexus:nexus@localhost:5432/nexus_test' : NEXUS_ENV === 'sandbox' ? 'postgres://nexus:nexus@localhost:5432/nexus' : undefined),
  jwtSecret: secret('JWT_SECRET', 'jwt-secret'),
  linkSecret: secret('LINK_SECRET', 'link-secret'),
  // Links sent to people point here. RENDER_EXTERNAL_URL is set by Render for the online demo (render.yaml).
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3001}`).replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : 0,
  uploadDir: env.UPLOAD_DIR || path.join(root, '.local', 'uploads'),
  // Payment rails for "held" custody: sandbox simulates a licensed partner; partner calls a real one over HTTP.
  provider: env.PAYMENT_PROVIDER || (NEXUS_ENV === 'live' ? 'partner' : 'sandbox'),
  partner: { baseUrl: env.PARTNER_BASE_URL, apiKey: env.PARTNER_API_KEY, webhookSecret: env.PARTNER_WEBHOOK_SECRET || (NEXUS_ENV === 'live' ? undefined : 'sandbox-webhook-secret') },
  // Notifications: sandbox writes to the in-app inbox and the log; live needs a WhatsApp/SMS provider.
  notifier: env.NOTIFIER || (NEXUS_ENV !== 'live' ? 'log' : env.SMS_PROVIDER === 'twilio' ? 'whatsapp' : 'sms'),
  // SMS_API_KEY is the Twilio auth token. Sender: SMS_FROM (number or alphanumeric ID) or a messaging service.
  // SMS_PROVIDER=smsgate sends through an Android phone running the open-source SMS Gateway app, with its own SIM:
  // one phone per country (SMSGATE_<COUNTRY>_USER/_PASSWORD), or one for all (SMSGATE_USER/_PASSWORD).
  smsgate: {
    baseUrl: (env.SMSGATE_BASE_URL || 'https://api.sms-gate.app/3rdparty/v1').replace(/\/$/, ''),
    default: gateway('SMSGATE'),
    byRegion: Object.fromEntries(Object.keys(REGIONS).map(id => [id, gateway(`SMSGATE_${id}`)]).filter(([, g]) => g)),
  },
  sms: {
    provider: env.SMS_PROVIDER, authToken: env.SMS_API_KEY, accountSid: env.TWILIO_ACCOUNT_SID,
    from: env.SMS_FROM, messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    baseUrl: (env.TWILIO_BASE_URL || 'https://api.twilio.com').replace(/\/$/, ''),
  },
  // WHATSAPP_TEMPLATES maps a notification template name to its approved Twilio Content SID, as JSON.
  whatsapp: { from: env.WHATSAPP_FROM, templates: jsonEnv('WHATSAPP_TEMPLATES') },
  // After a forgotten secret code is replaced, money actions wait this long: time for the owner to react to a stolen phone or SIM.
  pinResetHoldHours: Number(env.PIN_RESET_HOLD_HOURS || 24),
  // Earned-wage advances are lending: in live they stay closed until a licensed lender funds a credit line at the payment
  // partner. ADVANCE_LENDER names it (shown in audits); the sandbox simulates one.
  advances: { lender: env.ADVANCE_LENDER || null },
  autoReleaseDays: Number(env.AUTO_RELEASE_DAYS || 7),
  orderReleaseHours: Number(env.ORDER_RELEASE_HOURS || 72),
}

if (!config.databaseUrl) throw new Error('DATABASE_URL is required in live mode')
if (config.env === 'live') {
  // A pilot limited to "record" countries moves no money through Nexus, so it may run without a partner (PAYMENT_PROVIDER=none).
  // As soon as one open country is in "held" custody, a real partner is mandatory.
  const held = openRegionIds().filter(id => REGIONS[id].custody === 'held')
  if (config.provider === 'none') {
    if (held.length) throw new Error(`PAYMENT_PROVIDER=none is only for "record" countries, but ${held.join(', ')} hold funds: close them with SIGNUP_REGIONS or set CUSTODY_<ID>=record`)
  } else {
    if (config.provider !== 'partner') throw new Error('Live mode requires PAYMENT_PROVIDER=partner (or "none" when every open country is in "record" custody)')
    if (!config.partner.baseUrl || !config.partner.apiKey || !config.partner.webhookSecret) throw new Error('Live mode requires PARTNER_BASE_URL, PARTNER_API_KEY and PARTNER_WEBHOOK_SECRET')
  }
  if (!config.sms.provider) throw new Error('Live mode requires SMS_PROVIDER for login codes')
  // The lender's money reaches people through the partner: no partner, no advances.
  if (config.advances.lender && config.provider !== 'partner') throw new Error('ADVANCE_LENDER requires PAYMENT_PROVIDER=partner: advances are paid and repaid through the partner')
  if (!['sms', 'whatsapp'].includes(config.notifier)) throw new Error('Live mode requires NOTIFIER=sms or NOTIFIER=whatsapp')
}
// A messaging configuration is checked whenever one is given, so a sandbox pointed at a real account fails at boot, not at first send.
if (config.sms.provider) {
  if (!['twilio', 'smsgate'].includes(config.sms.provider)) throw new Error('SMS_PROVIDER must be "twilio" or "smsgate"')
  if (config.sms.provider === 'twilio') {
    if (!config.sms.accountSid || !config.sms.authToken) throw new Error('SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID and SMS_API_KEY (the auth token)')
    if (!config.sms.from && !config.sms.messagingServiceSid) throw new Error('SMS_PROVIDER=twilio requires SMS_FROM or TWILIO_MESSAGING_SERVICE_SID')
  } else if (!config.smsgate.default) {
    // Without a default phone, every country where someone can sign up needs its own, or their login codes cannot leave.
    const missing = openRegionIds().filter(id => !config.smsgate.byRegion[id])
    if (missing.length) throw new Error(`SMS_PROVIDER=smsgate requires SMSGATE_USER/SMSGATE_PASSWORD, or SMSGATE_<ID>_USER/_PASSWORD for each open country (missing: ${missing.join(', ')})`)
  }
}
if (!['log', 'sms', 'whatsapp'].includes(config.notifier)) throw new Error('NOTIFIER must be "log", "sms" or "whatsapp"')
if (config.notifier !== 'log' && !config.sms.provider) throw new Error(`NOTIFIER=${config.notifier} requires SMS_PROVIDER`)
if (config.notifier === 'whatsapp' && config.sms.provider !== 'twilio') throw new Error('NOTIFIER=whatsapp requires SMS_PROVIDER=twilio')
if (config.notifier === 'whatsapp' && !config.whatsapp.from) throw new Error('NOTIFIER=whatsapp requires WHATSAPP_FROM')
