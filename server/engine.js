import { pool, tx, one } from './db.js'
import { MODULES, ACTIONS, REGIONS, fill, validateCatalog, moduleAvailable } from './catalog.js'
import { fail, toMinor, normalizePhone, newId, sha256, stable } from './core.js'
import { ctxFor, balanceBlock, feedBlock } from './context.js'
import { verifyPin, assertNoPinHold } from './auth.js'
import wallet from './modules/wallet.js'
import tontine from './modules/tontine.js'
import escrow from './modules/escrow.js'
import jobs from './modules/jobs.js'
import { remit, family } from './modules/remit.js'
import { orders, creditbook, invoices } from './modules/commerce.js'
import { shifts, budget, float, score, scoreCard } from './modules/work.js'
import { trendBlock, moneyAlerts } from './insights.js'
import inbox from './modules/inbox.js'
import pos from './modules/pos.js'
import advance from './modules/advance.js'

export const MODS = { wallet, tontine, escrow, jobs, remit, family, orders, creditbook, invoices, shifts, budget, float, score, pos, advance, inbox }
validateCatalog(MODS)

const INTENT_TTL_MIN = 10
const label = (ctx, text) => fill(text, ctx.region.vocab)

function enabledModules(ctx) {
  return [...new Set([...ctx.persona.nav, ...ctx.region.modules])].filter(id => moduleAvailable(ctx.region, id))
}
function moduleFor(ctx, modId) {
  if (!Object.hasOwn(MODS, modId) || !enabledModules(ctx).includes(modId)) fail('Service indisponible pour votre compte', 404)
  return MODS[modId]
}
// Whether an action can be used by this user: custody stage, persona restrictions and roles.
function actionAllowed(ctx, modId, actId, act) {
  if (act.custody && act.custody !== ctx.region.custody) return false
  if (ctx.persona.deny?.includes(`${modId}.${actId}`)) return false
  if (act.role && !ctx.hasRole(act.role)) return false
  return true
}
function actionFor(ctx, modId, actId) {
  const mod = moduleFor(ctx, modId)
  const act = Object.hasOwn(mod.actions, actId) ? mod.actions[actId] : null
  if (!act || !actionAllowed(ctx, modId, actId, act)) fail('Action indisponible pour votre compte', 404)
  return act
}

// Validates and converts raw form input against the action's own field list; anything not declared is dropped.
function parseInput(fields, raw, ctx) {
  const out = {}
  for (const f of fields) {
    const v = typeof raw?.[f.name] === 'string' ? raw[f.name].trim() : raw?.[f.name]
    if (v === undefined || v === null || v === '') {
      if (f.required === false) continue
      fail(`${f.label} : champ requis`)
    }
    if (f.type === 'amount') out[f.name] = toMinor(v, f.currencyField ? REGIONS[out[f.currencyField]].currency : (f.currency ?? ctx.cur))
    else if (f.type === 'tel') out[f.name] = normalizePhone(v, ctx.region.dialCode)
    else if (f.type === 'number') {
      const n = Number(v)
      if (!Number.isInteger(n) || n < (f.min ?? 0) || n > (f.max ?? 1e6)) fail(`${f.label} : valeur invalide`)
      out[f.name] = n
    } else if (f.type === 'select') {
      if (!f.options.some(o => o.value === v)) fail(`${f.label} : choix invalide`)
      out[f.name] = v
    } else if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(`${f.label} : date invalide`)
      out[f.name] = v
    } else if (f.type === 'upload') {
      if (!/^[0-9a-f-]{36}$/.test(String(v))) fail(`${f.label} : fichier invalide`)
      out[f.name] = String(v)
    } else {
      if (String(v).length > (f.max ?? 80)) fail(`${f.label} : texte trop long`)
      out[f.name] = String(v)
    }
  }
  return out
}

export async function experience(client, ctx) {
  const mod = id => ({ id, icon: MODULES[id].icon, label: label(ctx, MODULES[id].label) })
  const enabled = enabledModules(ctx)
  const nav = ctx.persona.nav.filter(id => enabled.includes(id))
  const actions = ctx.persona.actions.map(id => ({ id, ...ACTIONS[id] })).filter(a => a.opens
    ? enabled.includes(a.opens)
    : enabled.includes(a.module) && Object.hasOwn(MODS[a.module].actions, a.action) && actionAllowed(ctx, a.module, a.action, MODS[a.module].actions[a.action]))
  return {
    region: { id: ctx.user.region, name: ctx.region.name, currency: ctx.cur, custody: ctx.region.custody },
    persona: { id: ctx.user.persona, label: ctx.persona.label, icon: ctx.persona.icon, hue: ctx.persona.hue, presentation: ctx.persona.presentation ?? {} },
    nav: [mod('home'), ...nav.map(mod), mod('services')],
    services: enabled.filter(id => !nav.includes(id)).map(mod),
    actions: actions.slice(0, 4).map(a => ({ ...a, label: label(ctx, a.label) })),
  }
}

export async function me(userId) {
  const c = pool
  const ctx = await ctxFor(c, userId)
  const pendingRoles = (await c.query(`SELECT role FROM roles WHERE user_id=$1 AND status='pending'`, [userId])).rows.map(r => r.role)
  const unread = (await one(c, 'SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [userId])).n
  return {
    user: { id: ctx.user.id, name: ctx.user.name, phone: ctx.user.phone, region: ctx.user.region, persona: ctx.user.persona, kycLevel: ctx.user.kyc_level, pendingRoles, isAdmin: ctx.hasRole('admin') },
    experience: await experience(c, ctx), unread,
  }
}

const MAX_INSIGHTS = 3

// What needs the person's attention: requests waiting on them (from the modules) first, then alerts computed from their money.
// A money warning (cash gap, short runway) always keeps one of the slots.
async function insights(ctx) {
  const found = []
  for (const id of enabledModules(ctx)) {
    const hit = await MODS[id]?.insight?.(ctx)
    if (hit) found.push({ type: 'insight', ...hit })
    if (found.length >= MAX_INSIGHTS) break
  }
  const alerts = await moneyAlerts(ctx)
  const warning = alerts.find(a => a.tone === 'warn')
  if (warning && found.length >= MAX_INSIGHTS) return [...found.slice(0, MAX_INSIGHTS - 1), warning]
  return [...found, ...alerts].slice(0, MAX_INSIGHTS)
}

export async function home(userId) {
  const ctx = await ctxFor(pool, userId)
  const exp = await experience(pool, ctx)
  const blocks = []
  for (const w of ctx.persona.home) {
    const title = label(ctx, w.title)
    if (w.type === 'balance') blocks.push(await balanceBlock(ctx, w.caption))
    else if (w.type === 'actions') blocks.push({ type: 'actions', items: exp.actions })
    else if (w.type === 'insight') blocks.push(...await insights(ctx))
    else if (w.type === 'feed') blocks.push(await feedBlock(ctx, title, 8))
    else if (w.type === 'trend') blocks.push(await trendBlock(ctx, title))
    else if (w.type === 'reputation') { if (enabledModules(ctx).includes('score')) blocks.push(await scoreCard(ctx, label(ctx, w.title))) }
    else if (moduleAvailable(ctx.region, w.module)) {
      const block = await MODS[w.module].widgets[w.type](ctx, w)
      if (block && !(block.type === 'rows' && !block.rows.length)) blocks.push({ ...block, title, module: w.module })
    }
  }
  if (ctx.user.kyc_level === 0 && ctx.held) blocks.splice(1, 0, { type: 'notice', icon: 'id-card', text: 'Vérifiez votre identité pour relever vos plafonds.', cta: { label: 'Vérifier', module: 'wallet', action: 'verify' } })
  return { blocks: blocks.filter(Boolean) }
}

export async function moduleView(userId, modId) {
  const ctx = await ctxFor(pool, userId)
  const mod = moduleFor(ctx, modId)
  const view = await mod.view(ctx)
  const actions = view.actions.filter(id => Object.hasOwn(mod.actions, id) && actionAllowed(ctx, modId, id, mod.actions[id]))
    .map(id => ({ id, label: label(ctx, mod.actions[id].label), icon: mod.actions[id].icon ?? 'plus' }))
  return {
    id: modId, label: label(ctx, MODULES[modId].label),
    blocks: view.blocks.filter(b => b && (b.type !== 'rows' || b.rows.length || b.empty)).map(b => ({ ...b, module: b.module ?? modId })),
    actions,
  }
}

export async function actionForm(userId, modId, actId, row) {
  const ctx = await ctxFor(pool, userId)
  const act = actionFor(ctx, modId, actId)
  const form = await act.form(ctx, row)
  return { ...form, title: label(ctx, form.title), needsReview: Boolean(act.plan) }
}

class Rollback extends Error {}

// Runs fn in a transaction that is always rolled back: outbox rows and postings it writes vanish.
async function dryRun(fn) {
  let result
  try { await tx(async c => { result = await fn(c); throw new Rollback() }) } catch (e) { if (!(e instanceof Rollback)) throw e }
  return result
}

// Records the request under its idempotency key, or returns the stored response. A reused key with different content is refused.
async function idempotent(c, userId, key, requestHash) {
  if (!key) fail('En-tête Idempotency-Key requis', 400)
  const ins = await c.query('INSERT INTO idempotency (user_id, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [userId, key, requestHash])
  if (ins.rowCount) return null
  const prev = await one(c, 'SELECT * FROM idempotency WHERE user_id=$1 AND key=$2', [userId, key])
  if (prev.request_hash !== requestHash) fail('Cette clé de requête a déjà servi pour une autre opération', 409)
  return prev.response
}
const saveResponse = (c, userId, key, response) => c.query('UPDATE idempotency SET response=$3 WHERE user_id=$1 AND key=$2', [userId, key, response])

// Money actions return a quote (intent) the user must confirm with the PIN; other actions run directly.
export async function perform(userId, modId, actId, { row = null, input = {}, idem = null, ip = null }) {
  const head = await ctxFor(pool, userId)
  const act = actionFor(head, modId, actId)
  const form = await act.form(head, row)
  if (form.blocked) fail(form.info ?? 'Action indisponible', 409)
  const values = parseInput(form.fields, input, head)
  if (act.plan) {
    const review = await dryRun(async c => {
      const ctx = await ctxFor(c, userId, ip)
      const plan = await act.plan(ctx, values, row)
      await plan.exec()
      return plan.review
    })
    const intentId = newId()
    await pool.query(`INSERT INTO intents (id, user_id, module, action, row_ref, input, review, review_hash, status, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'quoted', now() + make_interval(mins => $9))`,
      [intentId, userId, modId, actId, row, values, review, sha256(stable(review)), INTENT_TTL_MIN])
    return { review, intentId }
  }
  const requestHash = sha256(stable({ modId, actId, row, values }))
  return tx(async c => {
    const prev = await idempotent(c, userId, idem, requestHash)
    if (prev) return prev
    const ctx = await ctxFor(c, userId, ip)
    const result = { done: await act.run(ctx, values, row) }
    await ctx.audit(`${modId}.${actId}`, modId, row, { input: values })
    await saveResponse(c, userId, idem, result)
    return result
  })
}

export async function confirmIntent(userId, intentId, { pin, idem, ip }) {
  await verifyPin(userId, pin)
  await assertNoPinHold(userId)
  return tx(async c => {
    const prev = await idempotent(c, userId, idem, sha256(`confirm:${intentId}`))
    if (prev) return prev
    const intent = await one(c, `UPDATE intents SET status='confirmed' WHERE id=$1 AND user_id=$2 AND status='quoted' AND expires_at > now() RETURNING *`, [intentId, userId])
    if (!intent) fail('Ce devis a expiré ou a déjà été utilisé. Recommencez.', 409)
    const ctx = await ctxFor(c, userId, ip)
    const act = actionFor(ctx, intent.module, intent.action)
    const plan = await act.plan(ctx, intent.input, intent.row_ref)
    if (sha256(stable(plan.review)) !== intent.review_hash) fail('Le montant ou les conditions ont changé depuis le devis. Vérifiez à nouveau.', 409)
    const result = { done: await plan.exec() }
    await ctx.audit(`${intent.module}.${intent.action}`, intent.module, intent.row_ref, { intent: intentId, input: intent.input })
    await saveResponse(c, userId, idem, result)
    return result
  })
}

export const regionsCount = () => Object.keys(REGIONS).length
