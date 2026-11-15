import { pool, tx, one } from './db.js'
import { config } from './config.js'
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
import { shifts, budget, float, score, scoreCard, computeScore, LEVELS } from './modules/work.js'
import { trendBlock, moneyAlerts } from './insights.js'
import { notify } from './rails.js'
import inbox from './modules/inbox.js'
import pos from './modules/pos.js'
import advance from './modules/advance.js'
import { setModules } from './catalog-runtime.js'
import { driftSuggestion } from './drift.js'

export const MODS = { wallet, tontine, escrow, jobs, remit, family, orders, creditbook, invoices, shifts, budget, float, score, pos, advance, inbox }
validateCatalog(MODS)
setModules(MODS) // the runtime catalog validates new regions and profiles against the same registry

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

// Progressive disclosure: what the app SHOWS grows with the reputation level. It is visibility only, never permission:
// a locked module still opens from a link, an insight or a request someone sent (moduleFor does not look at levels),
// and every money rule (KYC, custody, roles) applies as before. The persona's first module (its wedge) is never locked.
const MAX_ACTIONS = 4
const isLocked = (ctx, id, level) => (MODULES[id].unlock ?? 0) > level && id !== ctx.persona.nav[0]
export const actionCount = level => Math.min(MAX_ACTIONS, 2 + level)

export async function experience(client, ctx, s = null) {
  s ??= await computeScore(client, ctx.user, ctx.party)
  const mod = id => ({ id, icon: MODULES[id].icon, label: label(ctx, MODULES[id].label) })
  const enabled = enabledModules(ctx)
  const visible = enabled.filter(id => !isLocked(ctx, id, s.level))
  const nav = ctx.persona.nav.filter(id => visible.includes(id))
  const actions = ctx.persona.actions.map(id => ({ id, ...ACTIONS[id] })).filter(a => a.opens
    ? visible.includes(a.opens)
    : visible.includes(a.module) && Object.hasOwn(MODS[a.module].actions, a.action) && actionAllowed(ctx, a.module, a.action, MODS[a.module].actions[a.action]))
  const locked = enabled.filter(id => isLocked(ctx, id, s.level)).map(id => {
    const at = MODULES[id].unlock
    return { ...mod(id), level: at + 1, name: LEVELS[at][1], pointsLeft: Math.max(0, LEVELS[at][0] - s.value) }
  }).sort((a, b) => a.level - b.level)
  return {
    region: { id: ctx.user.region, name: ctx.region.name, currency: ctx.cur, custody: ctx.region.custody },
    persona: { id: ctx.user.persona, label: ctx.persona.label, icon: ctx.persona.icon, hue: ctx.persona.hue, presentation: ctx.persona.presentation ?? {} },
    nav: [mod('home'), ...nav.map(mod), mod('services')],
    services: visible.filter(id => !nav.includes(id)).map(mod),
    actions: actions.slice(0, actionCount(s.level)).map(a => ({ ...a, label: label(ctx, a.label) })),
    moreActions: actions.length > actionCount(s.level),
    locked,
    level: { level: s.level + 1, name: LEVELS[s.level][1], value: s.value },
  }
}

// Once per level reached: a message in the inbox and, the first time the home screen is opened, a card saying what is new.
async function levelUp(ctx, s, exp) {
  if (s.level === 0) return null
  const dedupe = `level-up:${ctx.user.id}:${s.level}`
  if (await one(pool, 'SELECT 1 FROM notifications WHERE dedupe=$1', [dedupe])) return null
  const fresh = Object.entries(MODULES).filter(([id, m]) => m.unlock === s.level && enabledModules(ctx).includes(id)).map(([id, m]) => label(ctx, m.label))
  const extra = actionCount(s.level) > actionCount(s.level - 1) && exp.actions.length > actionCount(s.level - 1) ? 'une action rapide de plus sur l’accueil' : null
  const news = [...fresh, extra].filter(Boolean)
  const text = `Bravo, niveau ${s.level + 1} « ${LEVELS[s.level][1]} » !${news.length ? ` Nouveau : ${news.join(', ')}.` : ''}`
  await notify(pool, { userId: ctx.user.id, template: 'level.up', text, dedupe })
  return { type: 'insight', icon: 'sparkles', text, cta: { label: 'Voir ma réputation', module: 'score' } }
}

export async function me(userId) {
  const c = pool
  const ctx = await ctxFor(c, userId)
  const pendingRoles = (await c.query(`SELECT role FROM roles WHERE user_id=$1 AND status='pending'`, [userId])).rows.map(r => r.role)
  const unread = (await one(c, 'SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [userId])).n
  return {
    user: { id: ctx.user.id, name: ctx.user.name, phone: ctx.user.phone, region: ctx.user.region, persona: ctx.user.persona, kycLevel: ctx.user.kyc_level, pendingRoles, isAdmin: ctx.hasRole('admin') },
    experience: await experience(c, ctx), unread,
    sandbox: config.sandbox, // the interface offers a quick "change account" for testing every profile
  }
}

const MAX_INSIGHTS = 3

// What needs the person's attention: requests waiting on them (from the modules) first, then alerts computed from their money.
// A money warning (cash gap, short runway) always keeps one of the slots.
async function insights(ctx) {
  const found = []
  // Profile drift first: the person's activity says they have outgrown their profile.
  const drift = await driftSuggestion(ctx)
  if (drift) found.push({ type: 'insight', icon: 'sparkles', text: `${drift.why} : votre activité ressemble à celle du profil « ${drift.label} ». Passer à ce profil ? Vos paiements et votre réputation sont conservés.`, cta: { label: 'Voir le profil', module: 'services' } })
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
  const s = await computeScore(pool, ctx.user, ctx.party)
  const exp = await experience(pool, ctx, s)
  const blocks = []
  const nextUnlock = exp.locked[0] ? `Prochain déblocage : ${exp.locked[0].label} au niveau « ${exp.locked[0].name} » (encore ${exp.locked[0].pointsLeft} points)` : null
  for (const w of ctx.persona.home) {
    const title = label(ctx, w.title)
    if (w.type === 'balance') blocks.push(await balanceBlock(ctx, w.caption))
    else if (w.type === 'actions') blocks.push({ type: 'actions', items: exp.actions })
    else if (w.type === 'insight') { const up = await levelUp(ctx, s, exp); blocks.push(...(up ? [up] : []), ...await insights(ctx)) }
    else if (w.type === 'feed') blocks.push(await feedBlock(ctx, title, 8))
    else if (w.type === 'trend') blocks.push(await trendBlock(ctx, title))
    else if (w.type === 'reputation') { if (enabledModules(ctx).includes('score')) blocks.push(await scoreCard(ctx, label(ctx, w.title), { unlock: nextUnlock })) }
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
