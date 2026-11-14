import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

export const config = {
  env: NEXUS_ENV,
  sandbox: NEXUS_ENV !== 'live',
  port: Number(env.PORT || 3001),
  databaseUrl: env.DATABASE_URL || (NEXUS_ENV === 'test' ? 'postgres://nexus:nexus@localhost:5432/nexus_test' : NEXUS_ENV === 'sandbox' ? 'postgres://nexus:nexus@localhost:5432/nexus' : undefined),
  jwtSecret: secret('JWT_SECRET', 'jwt-secret'),
  linkSecret: secret('LINK_SECRET', 'link-secret'),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3001}`).replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : 0,
  uploadDir: env.UPLOAD_DIR || path.join(root, '.local', 'uploads'),
  // Payment rails for "held" custody: sandbox simulates a licensed partner; partner calls a real one over HTTP.
  provider: env.PAYMENT_PROVIDER || (NEXUS_ENV === 'live' ? 'partner' : 'sandbox'),
  partner: { baseUrl: env.PARTNER_BASE_URL, apiKey: env.PARTNER_API_KEY, webhookSecret: env.PARTNER_WEBHOOK_SECRET || (NEXUS_ENV === 'live' ? undefined : 'sandbox-webhook-secret') },
  // Notifications: sandbox writes to the in-app inbox and the log; live needs a WhatsApp/SMS provider.
  notifier: env.NOTIFIER || (NEXUS_ENV === 'live' ? 'whatsapp' : 'log'),
  // SMS_API_KEY is the Twilio auth token. Sender: SMS_FROM (number or alphanumeric ID) or a messaging service.
  sms: {
    provider: env.SMS_PROVIDER, authToken: env.SMS_API_KEY, accountSid: env.TWILIO_ACCOUNT_SID,
    from: env.SMS_FROM, messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    baseUrl: (env.TWILIO_BASE_URL || 'https://api.twilio.com').replace(/\/$/, ''),
  },
  // WHATSAPP_TEMPLATES maps a notification template name to its approved Twilio Content SID, as JSON.
  whatsapp: { from: env.WHATSAPP_FROM, templates: jsonEnv('WHATSAPP_TEMPLATES') },
  autoReleaseDays: Number(env.AUTO_RELEASE_DAYS || 7),
  orderReleaseHours: Number(env.ORDER_RELEASE_HOURS || 72),
}

if (!config.databaseUrl) throw new Error('DATABASE_URL is required in live mode')
if (config.env === 'live') {
  if (config.provider !== 'partner') throw new Error('Live mode requires PAYMENT_PROVIDER=partner')
  if (!config.partner.baseUrl || !config.partner.apiKey || !config.partner.webhookSecret) throw new Error('Live mode requires PARTNER_BASE_URL, PARTNER_API_KEY and PARTNER_WEBHOOK_SECRET')
  if (!config.sms.provider) throw new Error('Live mode requires SMS_PROVIDER for login codes')
  if (!['sms', 'whatsapp'].includes(config.notifier)) throw new Error('Live mode requires NOTIFIER=sms or NOTIFIER=whatsapp')
}
// A messaging configuration is checked whenever one is given, so a sandbox pointed at a real account fails at boot, not at first send.
if (config.sms.provider) {
  if (config.sms.provider !== 'twilio') throw new Error('SMS_PROVIDER must be "twilio"')
  if (!config.sms.accountSid || !config.sms.authToken) throw new Error('SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID and SMS_API_KEY (the auth token)')
  if (!config.sms.from && !config.sms.messagingServiceSid) throw new Error('SMS_PROVIDER=twilio requires SMS_FROM or TWILIO_MESSAGING_SERVICE_SID')
}
if (!['log', 'sms', 'whatsapp'].includes(config.notifier)) throw new Error('NOTIFIER must be "log", "sms" or "whatsapp"')
if (config.notifier !== 'log' && !config.sms.provider) throw new Error(`NOTIFIER=${config.notifier} requires SMS_PROVIDER`)
if (config.notifier === 'whatsapp' && !config.whatsapp.from) throw new Error('NOTIFIER=whatsapp requires WHATSAPP_FROM')
