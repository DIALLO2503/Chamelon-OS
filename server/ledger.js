import { one, all } from './db.js'
import { newId, fail, money } from './core.js'
import { REGIONS } from './catalog.js'

// System accounts that stand for money outside Nexus's shadow ledger (partner rail, FX position, commission expense,
// manual adjustments, the advance lender's credit line at the partner) may go negative. Every other account has a floor of zero.
const OPEN = new Set(['rail', 'fx', 'commissions', 'adjustments', 'lender'])
// Credits that undo or complete an earlier movement are never blocked by the balance cap, or money would get stuck.
const CAP_EXEMPT = new Set(['escrow_refund', 'escrow_release', 'payout_reversed', 'adjustment', 'tontine_out', 'order_refund'])
// Debits that pay back a debt are never blocked by spending limits, and do not use them up.
const OUTFLOW_EXEMPT = new Set(['advance_repay'])

export async function account(client, owner, kind, currency) {
  await client.query(
    'INSERT INTO accounts (id, owner, kind, currency, floor) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner, kind, currency) DO NOTHING',
    [newId(), owner, kind, currency, owner === 'system' && OPEN.has(kind) ? null : 0])
  return one(client, 'SELECT * FROM accounts WHERE owner=$1 AND kind=$2 AND currency=$3', [owner, kind, currency])
}
export const sys = (client, kind, currency) => account(client, 'system', kind, currency)
export const balanceOf = async (client, accountId) => (await one(client, 'SELECT balance FROM accounts WHERE id=$1', [accountId])).balance

// Outflow limits and the balance cap, per country and KYC level, for every user wallet the entry touches.
async function checkLimits(client, kind, lines) {
  const byAccount = new Map()
  for (const l of lines) if (l.account.kind === 'wallet' && l.account.owner !== 'system') byAccount.set(l.account.id, (byAccount.get(l.account.id) ?? 0) + l.amount)
  for (const [accountId, delta] of byAccount) {
    const acc = await one(client, `SELECT a.balance, a.currency, u.region, u.kyc_level, u.frozen FROM accounts a JOIN users u ON u.id::text = a.owner WHERE a.id=$1`, [accountId])
    if (!acc) continue
    if (acc.frozen) fail('Ce compte est suspendu. Contactez l’assistance.', 403)
    const lim = REGIONS[acc.region].limits[acc.kyc_level]
    const f = n => money(n, acc.currency)
    if (delta < 0 && OUTFLOW_EXEMPT.has(kind)) continue
    if (delta < 0) {
      const out = -delta
      if (out > lim.single) fail(`Montant au-delà de votre plafond par opération (${f(lim.single)}). Vérifiez votre identité pour l’augmenter.`)
      // Outflows minus payouts the partner failed and returned: a failed withdrawal does not use up the limit.
      const sums = await one(client, `SELECT
          COALESCE(SUM(CASE WHEN e.kind = 'advance_repay' THEN 0 WHEN p.amount < 0 THEN -p.amount WHEN e.kind = 'payout_reversed' THEN -p.amount ELSE 0 END) FILTER (WHERE p.created_at > now() - interval '1 day'), 0)::bigint AS day,
          COALESCE(SUM(CASE WHEN e.kind = 'advance_repay' THEN 0 WHEN p.amount < 0 THEN -p.amount WHEN e.kind = 'payout_reversed' THEN -p.amount ELSE 0 END) FILTER (WHERE p.created_at > date_trunc('month', now())), 0)::bigint AS month
        FROM postings p JOIN entries e ON e.id = p.entry_id WHERE p.account_id=$1`, [accountId])
      if (sums.day + out > lim.daily) fail(`Plafond journalier atteint (${f(lim.daily)}).`)
      if (sums.month + out > lim.monthly) fail(`Plafond mensuel atteint (${f(lim.monthly)}).`)
    } else if (!CAP_EXEMPT.has(kind) && acc.balance + delta > lim.balance) {
      fail(`Le solde du destinataire dépasserait son plafond (${f(lim.balance)}).`)
    }
  }
}

// lines: [{ account, amount (signed minor units, + increases the account), title, cpParty, ref, icon }]. Zero lines are dropped.
// Must run inside a transaction (client from tx()).
export async function post(client, { kind, idem = null, lines }) {
  lines = lines.filter(l => l.amount !== 0)
  const sums = {}
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount)) throw new Error('ledger: amount must be an integer')
    sums[l.account.currency] = (sums[l.account.currency] ?? 0) + l.amount
  }
  if (lines.length < 2 || Object.values(sums).some(s => s !== 0)) throw new Error('ledger: entry does not balance')
  const id = newId()
  const inserted = await client.query('INSERT INTO entries (id, kind, idem) VALUES ($1,$2,$3) ON CONFLICT (idem) DO NOTHING RETURNING id', [id, kind, idem])
  if (!inserted.rowCount) return (await one(client, 'SELECT id FROM entries WHERE idem=$1', [idem])).id
  // Lock every touched account in a fixed order so concurrent entries cannot deadlock or interleave.
  const ids = [...new Set(lines.map(l => l.account.id))].sort()
  await client.query('SELECT id FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
  await checkLimits(client, kind, lines)
  for (const l of lines) {
    await client.query('INSERT INTO postings (entry_id, account_id, amount, title, cp_party, ref, icon) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, l.account.id, l.amount, l.title ?? null, l.cpParty ?? null, l.ref ?? null, l.icon ?? null])
    try {
      await client.query('UPDATE accounts SET balance = balance + $1 WHERE id=$2', [l.amount, l.account.id])
    } catch (e) {
      if (e.code === '23514') fail('Solde insuffisant')
      throw e
    }
  }
  return id
}

// Moves `out` from one account and `into` to another; different currencies pass through the FX position.
export function legs(from, to, out, into, labels = {}) {
  const a = { account: from, amount: -out, ...labels.from }, b = { account: to, amount: into, ...labels.to }
  if (from.currency === to.currency) {
    if (out !== into) throw new Error('ledger: same-currency legs must match')
    return [a, b]
  }
  return { fx: true, from: a, to: b, out, into }
}
// Resolves FX legs (needs the FX system accounts) into plain lines.
export async function expand(client, parts) {
  const lines = []
  for (const p of parts.flat()) {
    if (p?.fx) {
      lines.push(p.from, { account: await sys(client, 'fx', p.from.account.currency), amount: p.out },
        { account: await sys(client, 'fx', p.to.account.currency), amount: -p.into }, p.to)
    } else if (p) lines.push(p)
  }
  return lines
}

export const feed = (client, accountId, limit) => all(client,
  `SELECT p.amount, p.title, p.icon, p.ref, p.created_at, pa.name AS cp_name, pa.user_id AS cp_user
   FROM postings p LEFT JOIN parties pa ON pa.id = p.cp_party WHERE p.account_id=$1 ORDER BY p.id DESC LIMIT $2`, [accountId, limit])

// Any row returned means a cached balance disagrees with its postings.
export const reconcile = client => all(client, `
  SELECT a.id, a.owner, a.kind, a.currency, a.balance, COALESCE(SUM(p.amount), 0)::bigint AS posted
  FROM accounts a LEFT JOIN postings p ON p.account_id = a.id GROUP BY a.id HAVING a.balance <> COALESCE(SUM(p.amount), 0)`)
