// Profile drift: when someone's real activity looks like the next tier of their value chain (a maâllem paying five
// workers, a seller with twenty paid orders a month), the app proposes the switch. Nothing changes without their
// explicit consent; a switch keeps every record, balance and reputation point, and can be undone after 30 days.
// Rules live in the catalog (persona.drift: [{ to, signal, min }]), so a new rule is a catalog change, not a deploy.
import { one } from './db.js'
import { REGIONS, CLOSED } from './catalog.js'
import { fail, newId } from './core.js'
import { notify } from './rails.js'

const COOLDOWN_DAYS = 30

// Each signal counts something other people confirmed or that money proves, never what the person declares.
export async function driftSignals(ctx) {
  const pid = ctx.party.id, uid = ctx.user.id
  const crew = await one(ctx.client, `SELECT count(DISTINCT payee_party)::int AS n FROM recorded_payments
    WHERE payer_party=$1 AND ref LIKE 'crew:%' AND status='confirmed' AND created_at > now() - interval '90 days'`, [pid])
  // A job is active while one of its stages is not yet paid.
  const jobs = await one(ctx.client, `SELECT count(*)::int AS n FROM jobs j WHERE j.artisan_party=$1
    AND EXISTS (SELECT 1 FROM job_stages s WHERE s.job_id=j.id AND s.status <> 'paid')`, [pid])
  const orders = await one(ctx.client, `SELECT count(*)::int AS n FROM orders WHERE seller_id=$1 AND status IN ('paid','delivered','completed') AND created_at > now() - interval '30 days'`, [uid])
  const paid = ctx.held
    ? await one(ctx.client, `SELECT count(*)::int AS n FROM postings p JOIN entries e ON e.id=p.entry_id WHERE p.account_id=$1 AND p.amount > 0 AND e.kind <> 'topup' AND p.created_at > now() - interval '30 days'`, [(await ctx.wallet()).id])
    : await one(ctx.client, `SELECT count(*)::int AS n FROM recorded_payments WHERE payee_party=$1 AND status='confirmed' AND created_at > now() - interval '30 days'`, [pid])
  return { crew_people: crew.n, jobs_active: jobs.n, orders_paid_30d: orders.n, payments_in_30d: paid.n }
}

const WHY = {
  crew_people: n => `Vous payez ${n} ouvriers différents`,
  jobs_active: n => `Vous menez ${n} chantiers en même temps`,
  orders_paid_30d: n => `${n} commandes payées ce mois-ci`,
  payments_in_30d: n => `${n} paiements reçus ce mois-ci`,
}

const lastChange = (client, userId) => one(client, 'SELECT * FROM persona_changes WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [userId])
const coolingDown = change => change && Date.now() - new Date(change.created_at).getTime() < COOLDOWN_DAYS * 86400000

// The first rule of the person's profile that their activity meets, if the target profile is open.
export async function driftSuggestion(ctx) {
  const rules = ctx.persona.drift ?? []
  if (!rules.length || coolingDown(await lastChange(ctx.client, ctx.user.id))) return null
  const s = await driftSignals(ctx)
  for (const r of rules) {
    const target = ctx.region.personas[r.to]
    if (!target || CLOSED.has(`${ctx.user.region}.${r.to}`) || target.restricted) continue
    if (s[r.signal] >= r.min) return { to: r.to, label: target.label, tier: target.tier ?? 1, why: WHY[r.signal](s[r.signal]) }
  }
  return null
}

// Profiles the person may switch to: open profiles of their region, except restricted ones (approved by the team).
export async function personaChoices(ctx) {
  const suggestion = await driftSuggestion(ctx)
  const last = await lastChange(ctx.client, ctx.user.id)
  return {
    current: ctx.user.persona,
    cooldownUntil: coolingDown(last) ? new Date(new Date(last.created_at).getTime() + COOLDOWN_DAYS * 86400000).toISOString() : null,
    suggestion,
    choices: Object.entries(ctx.region.personas)
      .filter(([pid, p]) => pid !== ctx.user.persona && !p.restricted && !CLOSED.has(`${ctx.user.region}.${pid}`))
      .map(([pid, p]) => ({ id: pid, label: p.label, tagline: p.tagline, icon: p.icon, hue: p.hue, tier: p.tier ?? 1, suggested: suggestion?.to === pid })),
  }
}

export async function switchPersona(ctx, to) {
  const target = REGIONS[ctx.user.region]?.personas[to]
  if (!target || to === ctx.user.persona) fail('Profil indisponible')
  if (CLOSED.has(`${ctx.user.region}.${to}`)) fail('Ce profil n’est plus proposé')
  if (target.restricted) fail('Ce profil est soumis à agrément : contactez notre équipe')
  const last = await lastChange(ctx.client, ctx.user.id)
  if (coolingDown(last)) fail(`Un changement de profil est possible tous les ${COOLDOWN_DAYS} jours`)
  const suggestion = await driftSuggestion(ctx)
  const reason = suggestion?.to === to ? 'drift' : 'choice'
  await ctx.client.query('UPDATE users SET persona=$2 WHERE id=$1', [ctx.user.id, to])
  await ctx.client.query('INSERT INTO persona_changes (id, user_id, from_persona, to_persona, reason) VALUES ($1,$2,$3,$4,$5)', [newId(), ctx.user.id, ctx.user.persona, to, reason])
  await ctx.audit('persona.switch', 'user', ctx.user.id, { from: ctx.user.persona, to, reason })
  await notify(ctx.client, { userId: ctx.user.id, template: 'persona.switched', text: `Votre application est maintenant celle du profil « ${target.label} ». Vos paiements, soldes et votre réputation sont conservés.`, dedupe: `persona:${ctx.user.id}:${to}:${new Date().toISOString().slice(0, 10)}` })
  return { persona: to, label: target.label, reason }
}

