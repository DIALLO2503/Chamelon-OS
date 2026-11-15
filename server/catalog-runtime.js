// The adaptive OS: regions and profiles can be created, edited, closed and reopened at runtime, without a deploy.
// A version is an overlay on top of the catalog in code (server/catalog.js): new or changed regions and profiles,
// closed regions and profiles, and FX rates for new currencies. One admin proposes, another approves (two-person rule).
// Every version is validated with the same rules as the code catalog before it can become active, and the previous
// versions stay, so any change can be rolled back by proposing an earlier overlay again.
// Applying a version rewrites the shared REGIONS / CURRENCIES / FX objects in place, so every module sees it at once;
// other server processes pick it up within CATALOG_SYNC_MS.
import { pool, tx, one, all } from './db.js'
import { REGIONS, FX_E8_PER_EUR, CLOSED, catalogErrors, refreshCurrencies, PRICING } from './catalog.js'
import { config } from './config.js'
import { fail } from './core.js'
import { log } from './log.js'

const clone = o => JSON.parse(JSON.stringify(o))
const BASE = clone(REGIONS)          // the code catalog, after CUSTODY_<ID> overrides
const BASE_FX = { ...FX_E8_PER_EUR }
const SYNC_MS = Number(process.env.CATALOG_SYNC_MS || 30000)
let mods = null                       // the module registry, set by engine.js (avoids an import cycle)
let activeId = null

export const setModules = registry => { mods = registry }

// Code catalog + overlay → the effective catalog. Region fields are replaced one by one; profiles one by one (null deletes).
export function merge(overlay = {}) {
  if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) fail('Le catalogue doit être un objet JSON')
  const regions = clone(BASE), fx = { ...BASE_FX }
  for (const [code, v] of Object.entries(overlay.fx ?? {})) {
    if (!/^[A-Z]{3}$/.test(code) || !/^\d{1,20}$/.test(String(v))) fail(`Taux de change invalide pour ${code} (unités par euro × 10⁸, en chiffres)`)
    fx[code] = BigInt(v)
  }
  for (const [rid, patch] of Object.entries(overlay.regions ?? {})) {
    if (patch === null) { delete regions[rid]; continue }
    if (typeof patch !== 'object') fail(`${rid} : région invalide`)
    const { personas = {}, ...fields } = patch
    const base = regions[rid] ?? { personas: {} }
    const next = { ...base, ...clone(fields), personas: { ...base.personas } }
    for (const [pid, p] of Object.entries(personas)) {
      if (p === null) delete next.personas[pid]
      else next.personas[pid] = clone(p)
    }
    regions[rid] = next
  }
  const closed = new Set(Array.isArray(overlay.closed) ? overlay.closed : [])
  return { regions, fx, closed }
}

// Everything that would stop this overlay from being activated, as plain sentences. Empty = valid.
export async function overlayErrors(overlay, client = pool) {
  let merged
  try { merged = merge(overlay) } catch (e) { return [e.message] }
  const { regions, fx, closed } = merged
  const errors = catalogErrors(mods, regions, fx)
  for (const key of closed) {
    const [rid, pid] = key.split('.')
    if (!regions[rid] || (pid && !regions[rid].personas[pid])) errors.push(`closed: ${key} n’existe pas`)
  }
  // A profile or region in use can be closed, never deleted: existing accounts must keep working.
  for (const u of await all(client, 'SELECT region, persona, count(*)::int AS n FROM users GROUP BY region, persona')) {
    if (!regions[u.region]) errors.push(`${u.n} compte(s) en ${u.region} : fermez la région au lieu de la supprimer`)
    else if (!regions[u.region].personas[u.persona]) errors.push(`${u.n} compte(s) utilisent ${u.region}.${u.persona} : fermez le profil au lieu de le supprimer`)
  }
  for (const [rid, r] of Object.entries(regions)) {
    if (closed.has(rid)) continue
    // Same live guards as config.js applies at boot: an open region must be servable.
    if (!config.sandbox && r.custody === 'held' && config.provider !== 'partner') errors.push(`${rid} : le stade held exige un partenaire de paiement`)
    if (config.sms.provider === 'smsgate' && !config.smsgate.default && !config.smsgate.byRegion[rid]) errors.push(`${rid} : aucun téléphone passerelle SMS configuré pour ce pays`)
    for (const c of r.corridors ?? []) if (PRICING.remitFee[r.currency?.code] === undefined) errors.push(`${rid} : couloir ${c} sans frais d’envoi pour ${r.currency?.code}`)
  }
  return [...new Set(errors)]
}

function apply({ regions, fx, closed }) {
  for (const k of Object.keys(REGIONS)) delete REGIONS[k]
  Object.assign(REGIONS, regions)
  Object.assign(FX_E8_PER_EUR, fx)
  CLOSED.clear()
  for (const k of closed) CLOSED.add(k)
  refreshCurrencies()
}

// Loads the active version (if it changed) and applies it. Called at boot, after each approval, and periodically.
export async function loadCatalog(client = pool) {
  const v = await one(client, `SELECT id, overlay FROM catalog_versions WHERE status='active'`)
  if ((v?.id ?? null) === activeId && activeId !== null) return activeId
  apply(merge(v?.overlay ?? {}))
  activeId = v?.id ?? null
  return activeId
}
// Tests and the demo reset: back to the code catalog.
export function resetCatalog() { apply(merge({})); activeId = null }

export function startCatalogSync() {
  const timer = setInterval(() => loadCatalog().catch(err => log.error({ err }, 'catalog sync failed')), SYNC_MS)
  return () => clearInterval(timer)
}

/* ---------------- versions: propose, approve, reject ---------------- */

export async function proposeVersion({ overlay, note, adminId }) {
  if (!String(note ?? '').trim()) fail('Motif requis')
  const errors = await overlayErrors(overlay)
  if (errors.length) fail(`Catalogue invalide : ${errors.slice(0, 5).join(' · ')}${errors.length > 5 ? ` (+${errors.length - 5})` : ''}`)
  return (await one(pool, `INSERT INTO catalog_versions (overlay, note, status, proposed_by) VALUES ($1,$2,'proposed',$3) RETURNING id`, [overlay, String(note).trim().slice(0, 300), adminId])).id
}

export async function approveVersion(id, adminId) {
  await tx(async c => {
    const v = await one(c, 'SELECT * FROM catalog_versions WHERE id=$1 FOR UPDATE', [id])
    if (!v) fail('Version introuvable', 404)
    if (v.status !== 'proposed') fail('Cette version n’est plus en attente', 409)
    if (v.proposed_by === adminId) fail('Une autre personne doit approuver cette version', 403)
    const errors = await overlayErrors(v.overlay, c)   // re-checked: accounts may have been created since the proposal
    if (errors.length) fail(`Catalogue invalide : ${errors.slice(0, 5).join(' · ')}`)
    await c.query(`UPDATE catalog_versions SET status='superseded' WHERE status='active'`)
    await c.query(`UPDATE catalog_versions SET status='active', approved_by=$2, activated_at=now() WHERE id=$1`, [id, adminId])
  })
  activeId = -1      // force a reload
  await loadCatalog()
}

export async function rejectVersion(id, adminId) {
  const r = await pool.query(`UPDATE catalog_versions SET status='rejected', approved_by=$2 WHERE id=$1 AND status='proposed'`, [id, adminId])
  if (!r.rowCount) fail('Aucune version en attente à rejeter', 409)
}

// What the console shows: the active overlay, the history, and the effective catalog with accounts per profile.
export async function catalogState() {
  const versions = await all(pool, `SELECT v.id, v.note, v.status, v.created_at, v.activated_at, v.overlay, p.name AS proposed_by_name, a.name AS approved_by_name
    FROM catalog_versions v LEFT JOIN users p ON p.id=v.proposed_by LEFT JOIN users a ON a.id=v.approved_by ORDER BY v.id DESC LIMIT 30`)
  const counts = Object.fromEntries((await all(pool, 'SELECT region, persona, count(*)::int AS n FROM users GROUP BY region, persona')).map(r => [`${r.region}.${r.persona}`, r.n]))
  const regions = Object.entries(REGIONS).map(([id, r]) => ({
    id, name: r.name, currency: r.currency.code, custody: r.custody, closed: CLOSED.has(id), fromCode: Boolean(BASE[id]),
    personas: Object.entries(r.personas).map(([pid, p]) => ({ id: pid, label: p.label, tier: p.tier ?? 1, icon: p.icon, closed: CLOSED.has(`${id}.${pid}`), users: counts[`${id}.${pid}`] ?? 0, fromCode: Boolean(BASE[id]?.personas[pid]), definition: p })),
  }))
  const active = versions.find(v => v.status === 'active')
  return { active: active ? { id: active.id, overlay: active.overlay } : { id: null, overlay: {} }, versions, regions }
}
