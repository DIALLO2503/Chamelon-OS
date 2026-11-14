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
  sms: { provider: env.SMS_PROVIDER, apiKey: env.SMS_API_KEY },
  autoReleaseDays: Number(env.AUTO_RELEASE_DAYS || 7),
  orderReleaseHours: Number(env.ORDER_RELEASE_HOURS || 72),
}

if (!config.databaseUrl) throw new Error('DATABASE_URL is required in live mode')
if (config.env === 'live') {
  if (config.provider !== 'partner') throw new Error('Live mode requires PAYMENT_PROVIDER=partner')
  if (!config.partner.baseUrl || !config.partner.apiKey || !config.partner.webhookSecret) throw new Error('Live mode requires PARTNER_BASE_URL, PARTNER_API_KEY and PARTNER_WEBHOOK_SECRET')
  if (!config.sms.provider || !config.sms.apiKey) throw new Error('Live mode requires SMS_PROVIDER and SMS_API_KEY for login codes')
}
