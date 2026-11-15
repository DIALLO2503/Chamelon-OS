// Everything that leaves the database: payment-provider calls, notifications, public links.
// External calls only happen through the outbox, after the transaction that decided them has committed,
// so a review (dry run, rolled back) or a failed transaction can never trigger a real payout or message.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { pool, tx, one, all } from './db.js'
import { config } from './config.js'
import { newId, sha256, fail, money } from './core.js'
import { post, sys } from './ledger.js'
import { log } from './log.js'
import { deliver } from './messaging.js'

export async function enqueue(client, kind, payload, idem) {
  await client.query('INSERT INTO outbox (kind, payload, idem) VALUES ($1,$2,$3) ON CONFLICT (idem) DO NOTHING', [kind, payload, idem])
}

/* ---------------- payment provider adapters ---------------- */

const sign = (body, secret) => createHmac('sha256', secret).update(body).digest('hex')

const sandboxProvider = {
  name: 'sandbox',
  async payout(op) { return { providerRef: `SBX-P-${op.id.slice(0, 8)}` } },
  async collect(op) { return { providerRef: `SBX-C-${op.id.slice(0, 8)}` } },
}
// Simulates the partner calling our webhook a moment later, signed like the real thing.
async function sandboxSettle(op, providerRef) {
  if ((config.env === 'test' && !process.env.SANDBOX_AUTO_SETTLE) || process.env.NEXUS_NO_AUTO_SETTLE) return
  setTimeout(() => {
    const body = JSON.stringify({ id: `evt_${providerRef}`, type: `${op.kind}.succeeded`, providerRef, amount: op.amount, currency: op.currency })
    handleWebhook(body, { 'x-signature': sign(body, config.partner.webhookSecret) }).catch(e => log.error({ err: e }, 'sandbox settle failed'))
  }, 400)
}

const partnerProvider = {
  name: 'partner',
  async call(path, body) {
    const res = await fetch(`${config.partner.baseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.partner.apiKey}`, 'Idempotency-Key': body.reference },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`partner ${path} ${res.status}`)
    return res.json()
  },
  async payout(op) { const r = await this.call('/payouts', { reference: op.id, amount: op.amount, currency: op.currency, phone: op.phone }); return { providerRef: r.id } },
  async collect(op) { const r = await this.call('/collections', { reference: op.id, amount: op.amount, currency: op.currency, phone: op.phone }); return { providerRef: r.id } },
}

// A "record"-only pilot has no partner: nothing should reach this, and if something does it fails loudly in the outbox.
const refuse = () => { throw new Error('No payment partner is configured (PAYMENT_PROVIDER=none)') }
const noProvider = { name: 'none', payout: refuse, collect: refuse }

export const provider = config.provider === 'partner' ? partnerProvider : config.provider === 'none' ? noProvider : sandboxProvider

/* ---------------- payouts and collections ---------------- */

// Money leaving Nexus to someone's mobile money: debited now into a suspense account, settled or reversed by webhook.
export async function startPayout(client, { source, amount, phone, userId = null, partyId = null, title, cpParty = null, purpose = {} }) {
  const id = newId(), currency = source.currency
  const suspense = await sys(client, 'payout_pending', currency)
  await post(client, { kind: 'payout', lines: [
    { account: source, amount: -amount, title, cpParty, icon: 'arrow-up-right', ref: `payout:${id}` },
    { account: suspense, amount, ref: `payout:${id}` }] })
  await client.query('INSERT INTO provider_ops (id, kind, status, amount, currency, phone, user_id, party_id, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, 'payout', 'pending', amount, currency, phone, userId, partyId, { ...purpose, source: source.id }])
  await enqueue(client, 'provider.payout', { opId: id }, `payout:${id}`)
  return id
}

// Money coming in from a payer's mobile money (who may have no account). The credit happens when the provider confirms.
export async function startCollection(client, { amount, currency, phone, partyId = null, purpose }) {
  const id = newId()
  await client.query('INSERT INTO provider_ops (id, kind, status, amount, currency, phone, party_id, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, 'collection', 'pending', amount, currency, phone, partyId, purpose])
  await enqueue(client, 'provider.collect', { opId: id }, `collect:${id}`)
  return id
}

// Business effects of a confirmed collection, registered by modules (e.g. an order becomes paid).
export const collectionHandlers = {}
// Business effects of a collection the payer refused or that failed (nothing was credited), by purpose.type.
export const collectionFailedHandlers = {}
// Business effects of a payout's outcome, by purpose.type. On failure the money is first returned to the account it left.
export const payoutHandlers = { succeeded: {}, failed: {} }

export async function handleWebhook(rawBody, headers) {
  const given = String(headers['x-signature'] ?? '')
  const expected = sign(rawBody, config.partner.webhookSecret)
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) fail('Signature invalide', 401)
  let evt
  try { evt = JSON.parse(rawBody) } catch { fail('Corps de requête invalide', 400) }
  if (!evt?.id || !evt?.providerRef || !evt?.type) fail('Événement incomplet', 400)
  return tx(async c => {
    const fresh = await c.query('INSERT INTO webhook_events (event_id, payload) VALUES ($1,$2) ON CONFLICT DO NOTHING', [evt.id, evt])
    if (!fresh.rowCount) return { duplicate: true }
    const op = await one(c, 'SELECT * FROM provider_ops WHERE provider_ref=$1 FOR UPDATE', [evt.providerRef])
    if (!op) fail('Opération inconnue', 404)
    if (op.status !== 'pending') return { ignored: op.status }
    if (evt.amount !== op.amount || evt.currency !== op.currency) fail('Montant ou devise incohérents', 422)
    const ok = evt.type.endsWith('.succeeded')
    await c.query('UPDATE provider_ops SET status=$2, updated_at=now() WHERE id=$1', [op.id, ok ? 'succeeded' : 'failed'])
    const suspenseKind = op.kind === 'payout' ? 'payout_pending' : null
    if (op.kind === 'payout') {
      const suspense = await sys(c, suspenseKind, op.currency)
      if (ok) await post(c, { kind: 'payout_settled', idem: `settle:${op.id}`, lines: [{ account: suspense, amount: -op.amount }, { account: await sys(c, 'rail', op.currency), amount: op.amount }] })
      else {
        const source = await one(c, 'SELECT * FROM accounts WHERE id=$1', [op.purpose.source])
        await post(c, { kind: 'payout_reversed', idem: `reverse:${op.id}`, lines: [{ account: suspense, amount: -op.amount }, { account: source, amount: op.amount, title: 'Paiement sortant échoué, remboursé', icon: 'rotate-ccw' }] })
        // Money returned to a system account (escrow, transit, pot…) must go on to its owner, or reach an admin.
        const handler = payoutHandlers.failed[op.purpose.type]
        if (handler) await handler(c, op, source)
        else if (source.owner === 'system') {
          const admins = await all(c, `SELECT user_id FROM roles WHERE role='admin' AND status='active'`)
          for (const a of admins) await notify(c, { userId: a.user_id, template: 'alert.payout_failed', text: `Paiement sortant échoué (${money(op.amount, op.currency)} vers ${op.phone}) : fonds revenus sur le compte système « ${source.kind} ». À traiter.`, dedupe: `payout-failed:${op.id}:${a.user_id}` })
        }
      }
      if (ok) await payoutHandlers.succeeded[op.purpose.type]?.(c, op)
    } else if (ok) {
      await collectionHandlers[op.purpose.type]?.(c, op)
    } else {
      await collectionFailedHandlers[op.purpose.type]?.(c, op)
    }
    return { ok: true }
  })
}

// Sandbox and tests: settle a pending operation as the partner would.
export async function simulateSettle(opId, outcome = 'succeeded') {
  const op = await one(pool, 'SELECT * FROM provider_ops WHERE id=$1', [opId])
  const body = JSON.stringify({ id: `evt_${op.provider_ref}_${outcome}`, type: `${op.kind}.${outcome}`, providerRef: op.provider_ref, amount: op.amount, currency: op.currency })
  return handleWebhook(body, { 'x-signature': sign(body, config.partner.webhookSecret) })
}

/* ---------------- notifications ---------------- */

// Users get an in-app message (and WhatsApp in live); parties without the app get WhatsApp/SMS through the outbox.
export async function notify(client, { userId = null, partyId = null, template, text, link = null, dedupe = null }) {
  let uid = userId
  if (!uid && partyId) uid = (await one(client, 'SELECT user_id FROM parties WHERE id=$1', [partyId]))?.user_id ?? null
  const channel = uid ? 'inapp' : 'whatsapp'
  const res = await client.query(
    'INSERT INTO notifications (user_id, party_id, channel, template, text, link, dedupe, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedupe) DO NOTHING RETURNING id',
    [uid, partyId, channel, template, text, link, dedupe, uid ? 'delivered' : 'pending'])
  if (res.rowCount && !uid) await enqueue(client, 'notify.send', { id: res.rows[0].id }, `notify:${res.rows[0].id}`)
}

const notifier = {
  async send(n, phone) {
    if (config.notifier === 'log') { log.info({ to: phone, text: n.text, link: n.link }, 'notification (sandbox: not sent)'); return }
    const { channel, ref } = await deliver(n, phone)
    log.info({ id: n.id, channel, ref }, 'notification sent')
    return channel
  },
}

/* ---------------- public links (no install) ---------------- */

export async function createLink(client, { kind, refId, partyId, days = 30 }) {
  const token = randomBytes(18).toString('base64url')
  await client.query('INSERT INTO links (id, token_hash, kind, ref_id, party_id, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6))',
    [newId(), sha256(token + config.linkSecret), kind, refId, partyId, days])
  return `${config.publicUrl}/l/${token}`
}
export async function resolveLink(client, token) {
  const link = await one(client, 'SELECT * FROM links WHERE token_hash=$1', [sha256(String(token) + config.linkSecret)])
  if (!link || link.revoked_at || new Date(link.expires_at) < new Date()) fail('Ce lien a expiré ou n’existe pas', 404)
  return link
}
export const shareFor = (text, url) => ({ text: `${text}\n${url}`, url, whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}` })

/* ---------------- outbox worker ---------------- */

const handlers = {
  async 'provider.payout'({ opId }) {
    const op = await one(pool, 'SELECT * FROM provider_ops WHERE id=$1', [opId])
    if (op.provider_ref) return
    const { providerRef } = await provider.payout(op)
    await pool.query('UPDATE provider_ops SET provider_ref=$2, updated_at=now() WHERE id=$1', [op.id, providerRef])
    if (provider.name === 'sandbox') await sandboxSettle(op, providerRef)
  },
  async 'provider.collect'({ opId }) {
    const op = await one(pool, 'SELECT * FROM provider_ops WHERE id=$1', [opId])
    if (op.provider_ref) return
    const { providerRef } = await provider.collect(op)
    await pool.query('UPDATE provider_ops SET provider_ref=$2, updated_at=now() WHERE id=$1', [op.id, providerRef])
    if (provider.name === 'sandbox') await sandboxSettle(op, providerRef)
  },
  async 'notify.send'({ id }) {
    const n = await one(pool, 'SELECT n.*, p.phone FROM notifications n JOIN parties p ON p.id = n.party_id WHERE n.id=$1', [id])
    const channel = await notifier.send(n, n.phone)
    // Records the channel actually used (WhatsApp, or SMS when the template has no approved WhatsApp counterpart).
    await pool.query(`UPDATE notifications SET status='sent', channel=COALESCE($2, channel) WHERE id=$1`, [id, channel ?? null])
  },
}

export async function drainOutbox(limit = 20) {
  const jobs = await tx(async c => {
    // A running job holds a 5-minute lease: if the process dies mid-job, the job becomes due again.
    const rows = await all(c, `SELECT * FROM outbox WHERE status IN ('pending','running') AND next_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])
    for (const j of rows) await c.query(`UPDATE outbox SET status='running', attempts=attempts+1, next_at=now() + interval '5 minutes' WHERE id=$1`, [j.id])
    return rows
  })
  for (const j of jobs) {
    try {
      await handlers[j.kind](j.payload)
      await pool.query(`UPDATE outbox SET status='done' WHERE id=$1`, [j.id])
    } catch (e) {
      const dead = j.attempts + 1 >= 8
      await pool.query(`UPDATE outbox SET status=$2, last_error=$3, next_at=now() + make_interval(secs => $4) WHERE id=$1`,
        [j.id, dead ? 'failed' : 'pending', String(e.message).slice(0, 500), 2 ** (j.attempts + 1)])
      log.warn({ job: j.kind, id: j.id, err: e.message }, dead ? 'outbox job failed permanently' : 'outbox job will retry')
    }
  }
  return jobs.length
}

let timer
export function startOutboxWorker(ms = 1000) {
  const loop = async () => { try { while (await drainOutbox() > 0); } catch (e) { log.error({ err: e }, 'outbox loop') } timer = setTimeout(loop, ms) }
  loop()
  return () => clearTimeout(timer)
}

export const describeAmount = (amount, currency) => money(amount, currency)
