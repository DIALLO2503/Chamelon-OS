// Sandbox demo data. Refuses to run outside the sandbox. Everything goes through the same engine actions a real user
// would trigger, with partner confirmations simulated, so balances, states and history match the ledger.
// The seed settles partner operations itself. When it runs inside the server (sandbox reset), the server's own simulated
// settlements may arrive too: they find the operation already settled and are ignored.
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { pool, tx, one, migrate } from './db.js'
import { createUser, hashPin } from './auth.js'
import * as engine from './engine.js'
import { drainOutbox, simulateSettle } from './rails.js'
import { jobOps } from './modules/jobs.js'
import { seedHistory } from './seed-history.js'

if (config.env !== 'sandbox') throw new Error('The demo seed only runs with NEXUS_ENV=sandbox')

export const DEMO_PIN = '2580'
const pinHash = hashPin(DEMO_PIN)
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString()

const USERS = [
  ['admin', '+33600000099', 'Admin Nexus', 'FR', 'sender', { roles: ['admin'] }],
  ['admin2', '+33600000098', 'Admin Contrôle', 'FR', 'sender', { roles: ['admin'] }],
  ['hassan', '+212600000001', 'Hassan Benali', 'MA', 'maallem'],
  ['youssef', '+212600000005', 'Youssef El Amrani', 'MA', 'ouvrier'],
  ['salma', '+212600000002', 'Salma Tazi', 'MA', 'seller'],
  ['brahim', '+212600000003', 'Brahim Ouazzani', 'MA', 'hanout'],
  ['khadija', '+212600000004', 'Khadija Bennani', 'MA', 'parent'],
  ['fatou', '+221770000001', 'Fatou Diallo', 'SN', 'seller', { fund: '185000' }],
  ['ibrahima', '+221770000002', 'Ibrahima Sow', 'SN', 'driver', { fund: '96000' }],
  ['aissatou', '+221770000003', 'Aïssatou Ba', 'SN', 'agent', { fund: '1850000', kyc: 2, roles: ['agent'] }],
  ['modou', '+221770000004', 'Modou Fall', 'SN', 'boutique', { fund: '420000' }],
  ['diarra', '+221770000005', 'Mame Diarra Ndiaye', 'SN', 'parent', { fund: '35000' }],
  ['mariama', '+224620000001', 'Mariama Camara', 'GN', 'commercante'],
  ['sekou', '+224620000002', 'Sékou Condé', 'GN', 'artisan'],
  ['aminata', '+33600000001', 'Aminata Sow', 'FR', 'student', { fund: '480' }],
  ['ousmane', '+33600000002', 'Ousmane Diallo', 'FR', 'sender', { fund: '1900' }],
  ['karim', '+33600000003', 'Karim Bennani', 'FR', 'builder', { fund: '9500' }],
  ['abdoulaye', '+971500000001', 'Abdoulaye Kane', 'AE', 'worker', { fund: '5200' }],
  ['samir', '+971500000002', 'Samir Khalil', 'AE', 'trader', { fund: '64000', kyc: 2 }],
  // One account for every remaining profile, so each one can be tried from the sign-in screen.
  ['alpha', '+224620000003', 'Alpha Diallo', 'GN', 'ouvrier'],
  ['fanta', '+224620000004', 'Fanta Sylla', 'GN', 'parent'],
  ['adjoua', '+2250700000001', 'Adjoua Kouassi', 'CI', 'seller'],
  ['awa', '+2250700000002', 'Awa Coulibaly', 'CI', 'commercante'],
  ['yao', '+2250700000003', 'Yao Konan', 'CI', 'artisan'],
  ['seydou', '+2250700000004', 'Seydou Traoré', 'CI', 'ouvrier'],
  ['akissi', '+2250700000005', 'Akissi N’Guessan', 'CI', 'parent'],
  ['marie', '+237650000001', 'Marie Ngono', 'CM', 'seller'],
  ['jeanpaul', '+237650000002', 'Jean-Paul Mbarga', 'CM', 'boutique'],
  ['fotso', '+237650000003', 'Emmanuel Fotso', 'CM', 'artisan'],
  ['ibrahim', '+237650000004', 'Ibrahim Moussa', 'CM', 'ouvrier'],
  ['brigitte', '+237650000005', 'Brigitte Atangana', 'CM', 'parent'],
  // Tier 2 profiles (the organiser one level up), reached by drift or chosen at sign-up.
  ['rachid', '+212600000006', 'Rachid Tazi BTP', 'MA', 'entreprise'],
  ['nawal', '+212600000007', 'Nawal Boutique', 'MA', 'boutique_pro'],
  ['khady', '+221770000006', 'Khady Diop', 'SN', 'boutique_pro', { fund: '650000' }],
  ['mamadou', '+224620000005', 'Mamadou Bah', 'GN', 'entreprise'],
  ['koffi', '+2250700000006', 'Koffi Yao', 'CI', 'entreprise'],
  ['aya', '+2250700000007', 'Aya Kouamé', 'CI', 'boutique_pro'],
  ['paul', '+237650000006', 'Paul Essomba', 'CM', 'entreprise'],
  ['clarisse', '+237650000007', 'Clarisse Ngo', 'CM', 'boutique_pro'],
]

async function settle() {
  await drainOutbox(200)
  for (const op of (await pool.query(`SELECT id FROM provider_ops WHERE status='pending' AND provider_ref IS NOT NULL`)).rows) await simulateSettle(op.id)
}

export async function seedDemo() {
  await migrate()
  if (await one(pool, 'SELECT 1 FROM users LIMIT 1')) return false
  const u = {}
  const act = async (who, mod, action, input = {}, row = null) => {
    const r = await engine.perform(u[who].id, mod, action, { row, input, idem: randomUUID() })
    const out = r.intentId ? await engine.confirmIntent(u[who].id, r.intentId, { pin: DEMO_PIN, idem: randomUUID() }) : r
    await settle()
    return out.done
  }
  for (const [key, phone, name, region, persona, opts = {}] of USERS) {
    u[key] = await tx(c => createUser(c, { phone, name, region, persona, pinHash, kycLevel: opts.kyc ?? 1, createdAt: daysAgo(120) }))
    for (const role of opts.roles ?? []) await pool.query(`INSERT INTO roles (user_id, role, status) VALUES ($1,$2,'active') ON CONFLICT (user_id, role) DO UPDATE SET status='active'`, [u[key].id, role])
    if (opts.fund) await act(key, 'wallet', 'topup', { amount: opts.fund })
  }
  const id = async (sql, ...args) => (await one(pool, sql, args)).id
  const party = async key => one(pool, 'SELECT * FROM parties WHERE user_id=$1', [u[key].id])

  // France → Morocco build: the builder creates the job with Hassan; stage 1 paid, stage 2 done and awaiting validation.
  await act('karim', 'jobs', 'create', { title: 'Maison familiale · Benslimane', country: 'MA', phone: u.hassan.phone, name: 'Hassan Benali', stage1: 'Fondations', amount1: '30000', stage2: 'Dalle', amount2: '12000', stage3: 'Murs', amount3: '18000' })
  const job = await id('SELECT id FROM jobs WHERE created_by=$1', u.karim.id)
  for (let i = 0; i < 2; i++) {
    await tx(async c => {
      const { createRequest } = await import('./modules/escrow.js')
      const stage = await one(c, `SELECT * FROM job_stages WHERE job_id=$1 AND status='planned' ORDER BY position LIMIT 1`, [job])
      const r = await createRequest(c, { payee: await party('hassan'), payer: await party('karim'), amount: stage.amount, currency: 'MAD', title: `Maison familiale · ${stage.title}`, mode: 'held', stageId: stage.id })
      await c.query(`UPDATE job_stages SET status='requested', escrow_id=$2 WHERE id=$1`, [stage.id, r.id])
    })
    await act('karim', 'jobs', 'fund', {}, job)
    await tx(async c => jobOps.markDone(c, job, await party('hassan')))
    if (i === 0) await act('karim', 'jobs', 'validate', {}, job)
  }

  // Morocco, stage 1 (no money moves): Hassan's local job with Brahim, paid directly and confirmed.
  await act('hassan', 'jobs', 'create', { title: 'Carrelage de la boutique', phone: u.brahim.phone, name: 'Brahim Ouazzani', stage1: 'Pose', amount1: '4500' })
  const local = await id('SELECT id FROM jobs WHERE created_by=$1', u.hassan.id)
  await act('hassan', 'jobs', 'done', {}, local)
  await act('brahim', 'jobs', 'validate', {}, local)
  await act('brahim', 'jobs', 'claimPaid', {}, local)

  // Blue-collar: Hassan pays his crew; Youssef confirms from the app, the other worker gets a link.
  await act('hassan', 'jobs', 'crew', { amount: '250', phones: `${u.youssef.phone}, +212600000066`, purpose: 'Journée chantier Benslimane' })
  await act('youssef', 'wallet', 'goal', { amount: '5000' })
  await act('youssef', 'wallet', 'confirmRecorded', {}, await id(`SELECT id FROM recorded_payments WHERE payee_party=(SELECT id FROM parties WHERE user_id=$1)`, u.youssef.id))

  // Savings groups.
  await act('hassan', 'tontine', 'create', { name: 'Daret du quartier', amount: '500', frequency: 'monthly', members: `${u.salma.phone}, ${u.brahim.phone}` })
  const daret = await id('SELECT id FROM tontines WHERE organiser_id=$1', u.hassan.id)
  await act('salma', 'tontine', 'accept', {}, daret)
  await act('brahim', 'tontine', 'accept', {}, daret)
  await act('salma', 'tontine', 'contribute', {}, daret)
  await act('fatou', 'tontine', 'create', { name: 'Natt des commerçantes', amount: '10000', frequency: 'monthly', members: `${u.ibrahima.phone}, ${u.modou.phone}` })
  const natt = await id('SELECT id FROM tontines WHERE organiser_id=$1', u.fatou.id)
  await act('ibrahima', 'tontine', 'accept', {}, natt)
  await act('modou', 'tontine', 'accept', {}, natt)
  await act('fatou', 'tontine', 'contribute', {}, natt)
  await act('modou', 'tontine', 'contribute', {}, natt)

  // Diaspora sending, including to Guinea and a monthly schedule.
  await act('ousmane', 'family', 'add', { phone: u.diarra.phone, name: 'Maman', relation: 'Mère' })
  await act('ousmane', 'family', 'add', { phone: '+224620000099', name: 'Tonton Alpha', relation: 'Oncle' })
  const maman = await id('SELECT id FROM beneficiaries WHERE user_id=$1 AND name=$2', u.ousmane.id, 'Maman')
  await act('ousmane', 'remit', 'send', { amount: '250', to: maman })
  await act('ousmane', 'remit', 'schedule', { amount: '250', to: maman, day: 5 })
  await act('ousmane', 'remit', 'send', { amount: '100', to: await id('SELECT id FROM beneficiaries WHERE user_id=$1 AND name=$2', u.ousmane.id, 'Tonton Alpha') })
  await act('abdoulaye', 'family', 'add', { phone: u.khadija.phone, name: 'Tante Khadija', relation: 'Tante' })
  await act('abdoulaye', 'remit', 'send', { amount: '600', to: await id('SELECT id FROM beneficiaries WHERE user_id=$1', u.abdoulaye.id) })

  // Protected orders in Senegal; direct-payment orders in Morocco.
  const o1 = await act('fatou', 'orders', 'create', { item: 'Robe wax', amount: '12500', customer: 'Ibrahima Sow' })
  await act('ibrahima', 'wallet', 'pay', { code: o1.copy })
  await act('fatou', 'orders', 'create', { item: 'Sac en cuir', amount: '18000', customer: 'Awa Gueye', phone: '+221770000077' })
  await act('salma', 'orders', 'create', { item: 'Caftan brodé', amount: '1200', customer: 'Imane Chraibi', phone: '+212600000077' })

  // Shops: credit books with phones (WhatsApp reminders) and supplier invoices.
  for (const [who, k] of [['brahim', 1], ['modou', 60], ['mariama', 900]]) {
    await act(who, 'creditbook', 'add', { name: 'Youssef', phone: who === 'modou' ? '+221770000088' : who === 'mariama' ? '+224620000088' : '+212600000088', amount: String(180 * k) })
    await act(who, 'creditbook', 'add', { name: 'Fatima Zahra', amount: String(65 * k) })
    await act(who, 'invoices', 'create', { supplier: 'Grossiste', amount: String(2100 * k), due: daysAgo(-6).slice(0, 10) })
  }
  await act('samir', 'invoices', 'create', { supplier: 'Al Noor Textiles', amount: '16800', due: daysAgo(-5).slice(0, 10) })
  await act('samir', 'escrow', 'hold', { amount: '3000', phone: u.salma.phone, name: 'Salma Tazi', title: 'Lot de tissus, livraison Casablanca' })

  // Guinea (stage 1): Sékou builds for Ousmane's family; deposit requested and paid directly.
  await act('sekou', 'escrow', 'request', { amount: '2500000', phone: '+224620000099', name: 'Tonton Alpha', title: 'Acompte fondations Kipé' })

  // Driver log, student budget, agent activity.
  for (const [d, gross, fuel] of [[6, 31000, 8000], [5, 42000, 8500], [4, 26000, 7000], [3, 47000, 9000], [2, 38000, 8500], [1, 29000, 6000]]) {
    await pool.query(`INSERT INTO shift_items (id, user_id, kind, label, amount, created_at) VALUES ($1,$2,'trip','Courses du jour',$3,$5), ($4,$2,'expense','Carburant',$6,$5)`, [randomUUID(), u.ibrahima.id, gross, randomUUID(), daysAgo(d), fuel])
  }
  await act('ibrahima', 'shifts', 'trip', { amount: '6500', label: 'Plateau → Almadies' })
  await act('ibrahima', 'shifts', 'expense', { amount: '8500', label: 'Carburant' })
  await act('aminata', 'budget', 'set', { amount: '900' })
  for (const [category, amount, label] of [['Loyer', '450', 'Résidence universitaire'], ['Courses', '86.40', 'Supermarché']]) await act('aminata', 'budget', 'expense', { category, amount, label })
  await act('aissatou', 'float', 'cashIn', { amount: '75000', phone: u.diarra.phone })

  // Côte d'Ivoire and Cameroon: a sale collected in person and confirmed, a credit book, a njangi being formed.
  await act('adjoua', 'pos', 'chargeRecorded', { amount: '15000', label: 'Pagne wax', phone: u.akissi.phone })
  await act('akissi', 'wallet', 'confirmRecorded', {}, await id(`SELECT recorded_id AS id FROM pos_sales WHERE user_id=$1`, u.adjoua.id))
  await act('awa', 'creditbook', 'add', { name: 'Mariam', phone: '+2250700000088', amount: '6500' })
  await act('jeanpaul', 'creditbook', 'add', { name: 'Pauline', phone: '+237650000088', amount: '4000' })
  await act('marie', 'tontine', 'create', { name: 'Njangi des commerçantes', amount: '10000', frequency: 'monthly', members: `${u.jeanpaul.phone}, ${u.brigitte.phone}` })

  // Six months of past sales and payments, so the home trend and money alerts have real data to show.
  await seedHistory(u)
  return true
}

// Sandbox only: empties every table (the schema and its migrations stay) and seeds the demo again.
// TRUNCATE does not fire the ledger's append-only triggers, which guard against UPDATE and DELETE.
export async function resetDemo() {
  if (config.env !== 'sandbox') throw new Error('The demo reset only runs with NEXUS_ENV=sandbox')
  await migrate()
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`)).rows.map(r => `"${r.tablename}"`)
  if (tables.length) await pool.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`)
  ;(await import('./catalog-runtime.js')).resetCatalog() // catalog versions are gone: back to the code catalog
  await seedDemo()
  return USERS.length
}

if (process.argv[1]?.endsWith('seed.js')) {
  process.env.NEXUS_NO_AUTO_SETTLE ??= '1' // run on its own, the seed settles partner operations itself
  const done = await seedDemo()
  console.log(done ? `Sandbox seeded: ${USERS.length} demo accounts, PIN ${DEMO_PIN}` : 'Database already has users; nothing seeded')
  await pool.end()
}
