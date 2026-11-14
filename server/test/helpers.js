process.env.NEXUS_ENV = 'test'
import { randomUUID } from 'node:crypto'

export const { pool, migrate, tx, one, all } = await import('../db.js')
export const { createUser, hashPin } = await import('../auth.js')
export const engine = await import('../engine.js')
export const rails = await import('../rails.js')
export const { reconcile, account } = await import('../ledger.js')
export const { safeguarding } = await import('../admin.js')
export const { REGIONS } = await import('../catalog.js')

export const PIN = '2580'
const PIN_HASH = hashPin(PIN)
const DIAL = { MA: '+2126', SN: '+22177', FR: '+336', AE: '+97150', GN: '+22462' }
let n = 0
export const phone = region => `${DIAL[region]}${String(1000000 + ++n).slice(-7)}`

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await migrate()
}

export async function user(region, persona, { kyc = 1, fund = 0, roles = [] } = {}) {
  const u = await tx(c => createUser(c, { phone: phone(region), name: `${persona} ${region} ${n}`, region, persona, pinHash: PIN_HASH, kycLevel: kyc }))
  for (const r of roles) await pool.query(`INSERT INTO roles (user_id, role, status) VALUES ($1,$2,'active') ON CONFLICT (user_id, role) DO UPDATE SET status='active'`, [u.id, r])
  if (fund) await topup(u, fund)
  return u
}

export const idem = () => randomUUID()

// Runs a module action; money actions are quoted then confirmed with the PIN.
export async function act(u, mod, action, input = {}, row = null, { pin = PIN } = {}) {
  const r = await engine.perform(u.id, mod, action, { row, input, idem: idem() })
  if (!r.intentId) return r
  return engine.confirmIntent(u.id, r.intentId, { pin, idem: idem() })
}
export const quote = (u, mod, action, input = {}, row = null) => engine.perform(u.id, mod, action, { row, input, idem: idem() })

// Settles every pending provider operation as the partner would (assigns refs through the outbox first).
export async function settleAll(outcome = 'succeeded') {
  await rails.drainOutbox(100)
  const ops = await all(pool, `SELECT id FROM provider_ops WHERE status='pending' AND provider_ref IS NOT NULL ORDER BY created_at`)
  for (const op of ops) await rails.simulateSettle(op.id, outcome)
  return ops.length
}

export async function topup(u, major) {
  await act(u, 'wallet', 'topup', { amount: String(major) })
  await settleAll()
}

export async function bal(u) {
  const a = await one(pool, `SELECT balance FROM accounts WHERE owner=$1 AND kind='wallet'`, [u.id])
  return a?.balance ?? 0
}

export async function healthy(assert) {
  assert.deepEqual(await reconcile(pool), [], 'cached balances match postings')
  const sums = await all(pool, 'SELECT currency, SUM(balance)::bigint AS s FROM accounts GROUP BY currency')
  for (const s of sums) assert.equal(s.s, 0, `currency ${s.currency} sums to zero`)
  for (const s of await safeguarding()) assert.ok(s.ok, `customer money in ${s.currency} is covered at the partner`)
}

export const partyOf = u => one(pool, 'SELECT * FROM parties WHERE user_id=$1', [u.id])
export const partyByPhone = p => one(pool, 'SELECT * FROM parties WHERE phone=$1', [p])

// Creates a public link for a party, as the app would have sent it, and returns the token.
export async function linkFor(kind, refId, partyId) {
  const url = await tx(c => rails.createLink(c, { kind, refId, partyId }))
  return url.split('/l/')[1]
}
