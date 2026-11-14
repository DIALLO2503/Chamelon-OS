// Grants the admin role: npm run admin:create -- +33612345678 ["Full Name"]
// With a name, the account is created if it does not exist yet: that is how the first admin gets in when their own
// country is closed to sign-up (SIGNUP_REGIONS). They then sign in with a login code and choose their secret code
// through "Code secret oublié ?". Needs NEXUS_ENV and DATABASE_URL like the server. Every grant is audited.
import { pool, tx, one, migrate } from '../db.js'
import { audit } from '../context.js'
import { createUser } from '../auth.js'
import { REGIONS } from '../catalog.js'

const [phone, name] = process.argv.slice(2)
if (!phone?.startsWith('+')) { console.error('Usage: npm run admin:create -- +<phone with country code> ["Full Name"]'); process.exit(1) }
await migrate()
let user = await one(pool, 'SELECT * FROM users WHERE phone=$1', [phone])
if (!user && !name) { console.error('No account with this phone. Sign up in the app first, or add a name to create the account.'); process.exit(1) }
await tx(async c => {
  if (!user) {
    const region = Object.keys(REGIONS).find(id => phone.startsWith(REGIONS[id].dialCode))
    if (!region) { console.error('This phone number is not from a country Nexus knows.'); process.exit(1) }
    user = await createUser(c, { phone, name, region, persona: Object.keys(REGIONS[region].personas)[0] })
  }
  await c.query(`INSERT INTO roles (user_id, role, status) VALUES ($1,'admin','active') ON CONFLICT (user_id, role) DO UPDATE SET status='active'`, [user.id])
  await audit(c, { actorType: 'system', actorId: 'cli', action: 'role.active', objectType: 'user', objectId: user.id, data: { role: 'admin' } })
})
console.log(`${user.name} (${phone}) is now an admin`)
await pool.end()
