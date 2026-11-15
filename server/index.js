import express from 'express'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { pool, migrate, all } from './db.js'
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
  const users = await all(pool, `SELECT u.phone, u.name, u.region, u.persona, EXISTS (SELECT 1 FROM roles r WHERE r.user_id=u.id AND r.role='admin' AND r.status='active') AS admin FROM users u ORDER BY u.created_at LIMIT 30`)
  res.json({ pin: '2580', accounts: users.map(u => ({ phone: u.phone, name: u.name, label: u.admin ? 'Administration' : `${REGIONS[u.region].personas[u.persona].label} · ${REGIONS[u.region].name} (${REGIONS[u.region].custody === 'held' ? 'avec partenaire' : 'paiements en direct'})` })) })
})
app.use('/api/auth', limit(20), auth)
app.use('/api/public', limit(60), publicUploadRoutes, publicRoutes)

const api = express.Router()
api.use(requireAuth)
const ctxArgs = req => ({ idem: req.get('Idempotency-Key') ?? null, ip: req.ip })
api.get('/me', async (req, res) => res.json(await engine.me(req.userId)))
api.get('/home', async (req, res) => res.json(await engine.home(req.userId)))
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
  startOutboxWorker()
  startScheduler()
  app.listen(config.port, () => log.info(`Nexus API on :${config.port} (${config.env})`))
}
