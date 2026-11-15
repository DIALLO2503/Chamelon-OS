import express from 'express'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { pool, migrate, all, one, tx } from './db.js'
import { audit } from './context.js'
import { AppError } from './core.js'
import { listRegions, REGIONS } from './catalog.js'
import { log } from './log.js'
import { auth, requireAuth, requireRole } from './auth.js'
import * as engine from './engine.js'
import { publicRoutes } from './public.js'
import { uploadRoutes, publicUploadRoutes } from './uploads.js'
import { adminRoutes } from './admin.js'
import { handleWebhook, startOutboxWorker, resolveLink } from './rails.js'
import { startScheduler } from './scheduler.js'
import { loadCatalog, startCatalogSync } from './catalog-runtime.js'
import { personaChoices, switchPersona } from './drift.js'
import { ctxFor } from './context.js'

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const testing = config.env === 'test'
const limit = (max, key) => rateLimit({ windowMs: 60_000, limit: testing ? 100_000 : max, standardHeaders: true, legacyHeaders: false,
  keyGenerator: key ?? (req => ipKeyGenerator(req.ip)), message: { error: 'Trop de requêtes, réessayez dans une minute' } })

export const app = express()
app.disable('x-powered-by')
app.set('trust proxy', config.trustProxy)
app.use(helmet({ contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', 'blob:'], 'connect-src': ["'self'"] } } }))

// The webhook needs the raw body for its signature, so it is mounted before the JSON parser.
app.post('/api/webhooks/provider', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => res.json(await handleWebhook(req.body.toString('utf8'), req.headers)))

app.use(express.json({ limit: '20kb' }))
app.use('/api', limit(300))

app.get('/api/health', async (_, res) => { await pool.query('SELECT 1'); res.json({ ok: true, env: config.env }) })
app.get('/api/config/regions', (_, res) => res.json({ regions: listRegions() }))
// Sandbox only: ready-made test accounts on the sign-in screen. Disabled entirely in live.
app.get('/api/config/sandbox', async (_, res) => {
  if (!config.sandbox) return res.json({ accounts: [] })
  const users = await all(pool, `SELECT u.phone, u.name, u.region, u.persona, EXISTS (SELECT 1 FROM roles r WHERE r.user_id=u.id AND r.role='admin' AND r.status='active') AS admin FROM users u ORDER BY u.created_at LIMIT 100`)
  // Grouped by country in catalog order, administrators first, so every profile is one tap away.
  const order = Object.keys(REGIONS)
  const accounts = users.map(u => ({
    phone: u.phone, name: u.name,
    group: u.admin ? 'Administration' : `${REGIONS[u.region].name} · ${REGIONS[u.region].custody === 'held' ? 'avec partenaire de paiement' : 'paiements en direct'}`,
    label: u.admin ? 'Administration' : REGIONS[u.region].personas[u.persona].label,
    rank: u.admin ? -1 : order.indexOf(u.region),
  })).sort((a, b) => a.rank - b.rank)
  res.json({ pin: '2580', reset: config.sandboxReset, accounts: accounts.map(({ rank, ...a }) => a) })
})
// Sandbox only: back to the original demo data (every account, balance and history), e.g. after testing every profile.
let resetting = false
app.post('/api/sandbox/reset', limit(3), async (req, res) => {
  if (!config.sandboxReset) return res.status(404).json({ error: 'Introuvable' })
  if (resetting) return res.status(409).json({ error: 'Réinitialisation déjà en cours' })
  resetting = true
  try {
    const { resetDemo } = await import('./seed.js')
    const accounts = await resetDemo()
    log.info({ ip: req.ip, accounts }, 'sandbox reset')
    res.json({ ok: true, accounts })
  } finally { resetting = false }
})
app.use('/api/auth', limit(20), auth)
app.use('/api/public', limit(60), publicUploadRoutes, publicRoutes)

const api = express.Router()
api.use(requireAuth)
const ctxArgs = req => ({ idem: req.get('Idempotency-Key') ?? null, ip: req.ip })
api.get('/me', async (req, res) => res.json(await engine.me(req.userId)))
// A person's own data, as a file they can keep (the right of access), and a request to close the account.
api.get('/me/export', limit(5, req => req.userId), async (req, res) => {
  const user = await one(pool, 'SELECT id, phone, name, region, persona, kyc_level, created_at, terms_version, terms_accepted_at FROM users WHERE id=$1', [req.userId])
  const party = await one(pool, 'SELECT id FROM parties WHERE user_id=$1', [req.userId])
  const mine = (sql, args = [party.id]) => all(pool, sql, args)
  const data = {
    exportedAt: new Date().toISOString(), account: user,
    recordedPayments: await mine(`SELECT created_at, confirmed_at, status, amount, currency, purpose, CASE WHEN payer_party=$1 THEN 'paid' ELSE 'received' END AS direction FROM recorded_payments WHERE payer_party=$1 OR payee_party=$1 ORDER BY created_at`),
    jobs: await mine(`SELECT j.title, j.currency, j.mode, j.created_at, CASE WHEN j.artisan_party=$1 THEN 'artisan' ELSE 'client' END AS role,
      (SELECT json_agg(json_build_object('position', s.position, 'title', s.title, 'amount', s.amount, 'status', s.status) ORDER BY s.position) FROM job_stages s WHERE s.job_id=j.id) AS stages
      FROM jobs j WHERE j.artisan_party=$1 OR j.client_party=$1 ORDER BY j.created_at`),
    orders: await mine(`SELECT item, amount, currency, status, mode, created_at, CASE WHEN seller_id=$2 THEN 'seller' ELSE 'buyer' END AS role FROM orders WHERE seller_id=$2 OR buyer_party=$1 ORDER BY created_at`, [party.id, req.userId]),
    protectedPayments: await mine(`SELECT title, amount, currency, status, mode, created_at, CASE WHEN payer_party=$1 THEN 'payer' ELSE 'payee' END AS role FROM escrows WHERE payer_party=$1 OR payee_party=$1 ORDER BY created_at`),
    tontines: await mine(`SELECT t.name, t.amount, t.currency, t.frequency, t.status, m.position, m.accepted_at FROM tontine_members m JOIN tontines t ON t.id=m.tontine_id WHERE m.party_id=$1 ORDER BY t.created_at`),
    messages: await mine(`SELECT created_at, text FROM notifications WHERE user_id=$1 ORDER BY created_at`, [req.userId]),
    activity: await mine(`SELECT created_at, action FROM audit_events WHERE actor_type='user' AND actor_id=$1 ORDER BY id`, [req.userId]),
  }
  await audit(pool, { actorId: req.userId, action: 'data.export', objectType: 'user', objectId: req.userId, ip: req.ip })
  res.set('Content-Disposition', 'attachment; filename="mes-donnees-nexus.json"').json(data)
})
api.post('/me/closure', limit(5, req => req.userId), async (req, res) => {
  await tx(async c => {
    const u = await one(c, 'SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.userId])
    if (u.closure_requested_at) return
    await c.query('UPDATE users SET closure_requested_at=now() WHERE id=$1', [u.id])
    await audit(c, { actorId: u.id, action: 'closure.request', objectType: 'user', objectId: u.id, ip: req.ip })
    for (const a of await all(c, `SELECT user_id FROM roles WHERE role='admin' AND status='active'`)) {
      await c.query(`INSERT INTO notifications (user_id, channel, template, text, status) VALUES ($1,'inapp','alert.closure',$2,'delivered')`, [a.user_id, `${u.name} (${u.phone}) demande la fermeture de son compte.`])
    }
  })
  res.json({ ok: true, message: 'Demande enregistrée. Notre équipe vous contacte avant de fermer le compte.' })
})
api.get('/home', async (req, res) => res.json(await engine.home(req.userId)))
// Profile drift and choice: the profiles a person may move to, and the switch itself (explicit, audited, 30-day cooldown).
api.get('/me/personas', async (req, res) => res.json(await personaChoices(await ctxFor(pool, req.userId))))
api.post('/me/persona', limit(10, req => req.userId), async (req, res) => res.json(await tx(async c => switchPersona(await ctxFor(c, req.userId, req.ip), String(req.body?.to ?? '')))))
api.get('/modules/:id', async (req, res) => res.json(await engine.moduleView(req.userId, req.params.id)))
api.get('/modules/:id/actions/:action', async (req, res) => res.json(await engine.actionForm(req.userId, req.params.id, req.params.action, req.query.row ?? null)))
api.post('/modules/:id/actions/:action', limit(60, req => req.userId), async (req, res) => res.json(await engine.perform(req.userId, req.params.id, req.params.action, { row: req.body?.row ?? null, input: req.body?.input, ...ctxArgs(req) })))
api.post('/intents/:id/confirm', limit(20, req => req.userId), async (req, res) => res.json(await engine.confirmIntent(req.userId, req.params.id, { pin: req.body?.pin, ...ctxArgs(req) })))
api.use('/uploads', uploadRoutes)
api.use('/admin', requireRole('admin'), adminRoutes)
app.use('/api', api)
app.use('/api', (_, res) => res.status(404).json({ error: 'Introuvable' }))

if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false }))
  // Messaging apps fetch a shared link to draw its preview and do not run scripts: the title and description must be in
  // the HTML itself. The text says what kind of request it is and nothing else: no name, no amount (previews are cached
  // on the messaging app's servers). An unknown or expired link gets the generic page.
  const shell = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const PREVIEW = {
    recorded: 'Un paiement à confirmer',
    escrow: 'Une demande de paiement protégé',
    job: 'Votre chantier : suivez et validez chaque étape',
    order: 'Votre commande : payez et suivez la livraison',
    tontine: 'Une invitation à rejoindre une tontine',
    statement: 'Votre relevé de crédit chez votre commerçant',
  }
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  app.get('/l/:token', async (req, res) => {
    const link = await resolveLink(pool, req.params.token).catch(() => null)
    const title = PREVIEW[link?.kind] ?? 'Nexus'
    const tags = [['og:site_name', 'Nexus'], ['og:title', title], ['og:description', 'Ouvrez ce lien pour répondre. Aucune application à installer.'],
      ['og:image', `${config.publicUrl}/icon-512.png`], ['og:type', 'website']]
      .map(([p, c]) => `<meta property="${p}" content="${esc(c)}" />`).join('\n    ')
    res.type('html').set('Cache-Control', 'no-store').send(shell.replace('<title>Nexus</title>', `<title>${esc(title)}</title>\n    ${tags}`))
  })
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next()))
}

app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Requête invalide' })
  if (err instanceof AppError || (err.status && err.status < 500 && err.expose !== false && err.message)) return res.status(err.status).json({ error: err.message })
  log.error({ err, path: req.path }, 'unhandled error')
  res.status(500).json({ error: 'Une erreur est survenue. Réessayez ; si un débit apparaît par erreur, il sera corrigé.' })
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate()
  await loadCatalog()
  startCatalogSync()
  startOutboxWorker()
  startScheduler()
  app.listen(config.port, () => log.info(`Nexus API on :${config.port} (${config.env})`))
}
