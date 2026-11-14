// Grants the admin role to an existing account: npm run admin:create -- +33612345678
// Needs NEXUS_ENV and DATABASE_URL like the server. Every grant is written to the audit log.
import { pool, tx, one } from '../db.js'
import { audit } from '../context.js'

const phone = process.argv[2]
if (!phone?.startsWith('+')) { console.error('Usage: npm run admin:create -- +<phone with country code>'); process.exit(1) }
const user = await one(pool, 'SELECT * FROM users WHERE phone=$1', [phone])
if (!user) { console.error('No account with this phone. Sign up in the app first.'); process.exit(1) }
await tx(async c => {
  await c.query(`INSERT INTO roles (user_id, role, status) VALUES ($1,'admin','active') ON CONFLICT (user_id, role) DO UPDATE SET status='active'`, [user.id])
  await audit(c, { actorType: 'system', actorId: 'cli', action: 'role.active', objectType: 'user', objectId: user.id, data: { role: 'admin' } })
})
console.log(`${user.name} (${phone}) is now an admin`)
await pool.end()
