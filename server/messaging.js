// Outbound SMS and WhatsApp. Two SMS providers: Twilio's Messages API (also the only WhatsApp route), and SMS Gateway
// for Android (sms-gate.app, open source): a phone with a local SIM sends the messages, one phone per country.
// Nothing here touches the database: auth.js calls sendSms for login codes, the outbox worker in rails.js calls deliver.
// Message bodies are never logged: a login code is a credential.
import { config } from './config.js'
import { REGIONS } from './catalog.js'

const TIMEOUT_MS = 10_000

async function twilioSend(params) {
  const { accountSid, authToken, baseUrl, messagingServiceSid } = config.sms
  const body = new URLSearchParams(params)
  // A messaging service picks the sender per destination (alphanumeric ID, short code, number); it replaces From for SMS.
  if (messagingServiceSid && !params.From) body.set('MessagingServiceSid', messagingServiceSid)
  let res
  try {
    res = await fetch(`${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(`Twilio unreachable: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Twilio ${res.status}${data.code ? ` (code ${data.code})` : ''}: ${data.message || 'request refused'}`)
  return { ref: data.sid ?? null }
}

// The request is accepted by the relay, then pushed to the phone, which sends it from its SIM: a 2xx here means queued,
// not delivered. A phone that is off or out of credit shows up in the app on the phone, not in this response.
async function smsgateSend(phone, text) {
  const region = Object.keys(REGIONS).find(id => phone.startsWith(REGIONS[id].dialCode))
  const gw = config.smsgate.byRegion[region] ?? config.smsgate.default
  if (!gw) throw new Error(`No SMS gateway phone configured for ${region ?? 'this country'}`)
  let res
  try {
    res = await fetch(`${gw.url ?? config.smsgate.baseUrl}/message`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${gw.user}:${gw.password}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ textMessage: { text }, phoneNumbers: [phone] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(`SMS gateway unreachable: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`SMS gateway ${res.status}: ${data.message || 'request refused'}`)
  return { ref: data.id ?? null }
}

export const smsConfigured = () => Boolean(config.sms.provider)

export function sendSms(phone, text) {
  if (!smsConfigured()) throw new Error('No SMS provider configured')
  if (config.sms.provider === 'smsgate') return smsgateSend(phone, text)
  return twilioSend({ To: phone, Body: text, ...(config.sms.messagingServiceSid ? {} : { From: config.sms.from }) })
}

// WhatsApp only lets a business open a conversation with a pre-approved template. Each notification template maps to a
// Twilio Content SID in WHATSAPP_TEMPLATES; the approved template takes {{1}} = text and {{2}} = link.
export function sendWhatsApp(phone, contentSid, { text, link }) {
  return twilioSend({
    To: `whatsapp:${phone}`, From: `whatsapp:${config.whatsapp.from}`, ContentSid: contentSid,
    ContentVariables: JSON.stringify({ 1: text, 2: link || config.publicUrl }),
  })
}

// Delivers a notification to someone without the app. Returns the channel actually used.
// NOTIFIER=whatsapp falls back to SMS for a template with no approved WhatsApp counterpart, so no message is silently lost.
export async function deliver(n, phone) {
  const sid = config.notifier === 'whatsapp' ? config.whatsapp.templates[n.template] : null
  if (sid) return { channel: 'whatsapp', ...(await sendWhatsApp(phone, sid, n)) }
  return { channel: 'sms', ...(await sendSms(phone, n.link ? `${n.text}\n${n.link}` : n.text)) }
}
