import { pool, one, all } from './db.js'
import { REGIONS, CURRENCIES } from './catalog.js'
import { account, feed, balanceOf } from './ledger.js'
import { fmt, fail, normalizePhone, ago, newId, mask } from './core.js'

export const audit = (client, { actorType = 'user', actorId, action, objectType, objectId, data, ip }) =>
  client.query('INSERT INTO audit_events (actor_type, actor_id, action, object_type, object_id, data, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [actorType, actorId ?? null, action, objectType ?? null, objectId ?? null, data ?? null, ip ?? null])

// A party is anyone Nexus deals with, identified by phone; it links to a user once that phone has an account.
export async function partyByPhone(client, phone, name) {
  await client.query('INSERT INTO parties (id, phone, name) VALUES ($1,$2,$3) ON CONFLICT (phone) DO NOTHING', [newId(), phone, name || phone])
  const p = await one(client, 'SELECT * FROM parties WHERE phone=$1', [phone])
  if (name && p.name === p.phone) await client.query('UPDATE parties SET name=$2 WHERE id=$1', [p.id, name])
  return p
}
export async function partyForUser(client, user) {
  await client.query('INSERT INTO parties (id, phone, name, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT (phone) DO UPDATE SET user_id = EXCLUDED.user_id, name = EXCLUDED.name',
    [newId(), user.phone, user.name, user.id])
  return one(client, 'SELECT * FROM parties WHERE phone=$1', [user.phone])
}
export const partyById = (client, id) => one(client, 'SELECT * FROM parties WHERE id=$1', [id])
export const userById = (client, id) => one(client, 'SELECT * FROM users WHERE id=$1', [id])
export const curOf = user => REGIONS[user.region].currency
export const walletOf = (client, user) => account(client, user.id, 'wallet', curOf(user).code)

const LOOKUPS_PER_DAY = 40

export async function ctxFor(client, userId, ip = null) {
  const user = await userById(client, userId)
  if (!user) fail('Compte introuvable', 401)
  const region = REGIONS[user.region], cur = region.currency
  const roles = await all(client, 'SELECT role, status FROM roles WHERE user_id=$1', [user.id])
  const party = await partyForUser(client, user)
  const ctx = {
    client, user, region, cur, party, ip, persona: region.personas[user.persona],
    held: region.custody === 'held',
    hasRole: role => roles.some(r => r.role === role && r.status === 'active'),
    wallet: () => walletOf(client, user),
    f: minor => fmt(minor, cur),
    audit: (action, objectType, objectId, data) => audit(client, { actorId: user.id, action, objectType, objectId, data, ip }),
    // Any phone, with or without an account. Local numbers use the user's dial code; abroad needs the + prefix.
    async findParty(phone, name) {
      const normalized = normalizePhone(phone, region.dialCode)
      if (normalized === user.phone) fail('Ce numéro est le vôtre')
      return partyByPhone(client, normalized, name)
    },
    // A counterparty that must have an account (wallet-to-wallet flows). Lookups are rate-limited and logged.
    async findUser(phone) {
      const normalized = normalizePhone(phone, region.dialCode)
      if (normalized === user.phone) fail('Ce numéro est le vôtre')
      // Counted and logged outside the caller's transaction, so quotes (which roll back) still count.
      const n = (await one(pool, `SELECT count(*)::int AS n FROM audit_events WHERE actor_id=$1 AND action='lookup' AND created_at > now() - interval '1 day'`, [user.id])).n
      if (n >= LOOKUPS_PER_DAY) fail('Trop de recherches aujourd’hui. Réessayez demain.', 429)
      await audit(pool, { actorId: user.id, action: 'lookup', objectType: 'phone', objectId: normalized, ip })
      const found = await one(client, 'SELECT * FROM users WHERE phone=$1', [normalized])
      if (!found) fail('Ce numéro n’a pas encore de compte Nexus. Envoyez-lui plutôt une demande ou un lien.', 404)
      return found
    },
  }
  return ctx
}

// Name shown to someone other than the person: masked unless they are already linked (beneficiary, own customer).
export const shown = name => mask(name)

export async function balanceBlock(ctx, caption) {
  if (ctx.held) return { type: 'balance', amount: ctx.f(await balanceOf(ctx.client, (await ctx.wallet()).id)), caption: caption ?? 'Solde disponible' }
  const r = await one(ctx.client, `SELECT COALESCE(SUM(amount) FILTER (WHERE payee_party=$1),0)::bigint AS inn, COALESCE(SUM(amount) FILTER (WHERE payer_party=$1),0)::bigint AS out
    FROM recorded_payments WHERE status='confirmed' AND currency=$2 AND (payee_party=$1 OR payer_party=$1) AND created_at > date_trunc('month', now())`, [ctx.party.id, ctx.cur.code])
  return { type: 'balance', amount: ctx.f(r.inn), caption: 'Reçu ce mois, confirmé', sub: `Payé ce mois : ${ctx.f(r.out)}` }
}

const group = (rows, toItem) => {
  const days = []
  for (const r of rows) {
    const label = ago(r.created_at)
    if (days.at(-1)?.label !== label) days.push({ label, items: [] })
    days.at(-1).items.push(toItem(r))
  }
  return days
}

export async function feedBlock(ctx, title, limit) {
  if (ctx.held) {
    const rows = await feed(ctx.client, (await ctx.wallet()).id, limit)
    return { type: 'feed', title, empty: 'Aucune opération pour le moment.', days: group(rows, p => ({
      icon: p.icon ?? (p.amount > 0 ? 'arrow-down-left' : 'arrow-up-right'), title: p.title ?? 'Opération', sub: p.cp_name ? mask(p.cp_name) : '',
      value: (p.amount > 0 ? '+' : '−') + ctx.f(Math.abs(p.amount)), positive: p.amount > 0,
    })) }
  }
  const rows = await all(ctx.client, `SELECT r.*, pa.name AS payer_name, pb.name AS payee_name FROM recorded_payments r
    JOIN parties pa ON pa.id=r.payer_party JOIN parties pb ON pb.id=r.payee_party
    WHERE (r.payer_party=$1 OR r.payee_party=$1) AND r.status <> 'rejected' ORDER BY r.created_at DESC LIMIT $2`, [ctx.party.id, limit])
  return { type: 'feed', title, empty: 'Aucun paiement enregistré pour le moment.', days: group(rows, r => {
    const incoming = r.payee_party === ctx.party.id
    return {
      icon: incoming ? 'arrow-down-left' : 'arrow-up-right', title: r.purpose,
      sub: `${mask(incoming ? r.payer_name : r.payee_name)} · ${r.status === 'confirmed' ? 'confirmé' : 'en attente de confirmation'}`,
      value: (incoming ? '+' : '−') + fmt(r.amount, CURRENCIES[r.currency]), positive: incoming && r.status === 'confirmed',
    }
  }) }
}

export const rowsBlock = (title, icon, rows, empty) => ({ type: 'rows', title, icon, rows, empty })
