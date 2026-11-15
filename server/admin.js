// Back-office for operations staff. Money-affecting decisions (dispute outcomes, manual adjustments) need two different admins:
// one proposes, another approves.
import { Router } from 'express'
import { pool, tx, one, all, transition } from './db.js'
import { REGIONS, CURRENCIES } from './catalog.js'
import { fail, newId, money, mask } from './core.js'
import { audit, partyById, walletOf, userById } from './context.js'
import { post, sys, reconcile } from './ledger.js'
import { notify } from './rails.js'
import { loadEscrow, releaseEscrow, refundEscrow, escrowHooks } from './modules/escrow.js'

export const adminRoutes = Router()
const log = (c, req, action, objectType, objectId, data) => audit(c, { actorType: 'admin', actorId: req.userId, action, objectType, objectId, data, ip: req.ip })

// Customer money the partner must hold (wallets, escrow, pots, in-flight payouts) against what it holds: net money in through
// the rail, adjusted by currency conversions (converted at the partner), plus Nexus's own operating money spent on commissions
// and adjustments (Nexus must keep its operating account at the partner funded to cover them).
export async function safeguarding(client = pool) {
  const rows = await all(client, `SELECT currency,
      COALESCE(SUM(balance) FILTER (WHERE owner <> 'system' OR kind IN ('escrow','payout_pending','returns','remit_transit','fx_out')),0)::bigint AS owed,
      COALESCE(-SUM(balance) FILTER (WHERE owner='system' AND kind IN ('rail','fx','adjustments','commissions')),0)::bigint AS held_at_partner
    FROM accounts GROUP BY currency ORDER BY currency`)
  return rows.map(r => ({ ...r, ok: r.owed <= r.held_at_partner, owedText: money(r.owed, r.currency), heldText: money(r.held_at_partner, r.currency) }))
}

// The pilot's main measure: of the people who were sent a link, how many opened it, acted on it, and later signed up.
// One invitation = one person on one object (a job, an order...), however many times the link was re-sent.
export async function linkFunnel(days = 30) {
  const ids = Object.keys(REGIONS)
  const rows = await all(pool, `
    WITH inv AS (
      SELECT l.kind, l.party_id, l.ref_id, min(l.created_at) AS sent_at, min(l.first_opened_at) AS opened_at, min(l.first_acted_at) AS acted_at
      FROM links l WHERE l.created_at > now() - make_interval(days => $3) GROUP BY l.kind, l.party_id, l.ref_id)
    SELECT COALESCE(r.id, '?') AS region, i.kind, count(*)::int AS sent, count(i.opened_at)::int AS opened, count(i.acted_at)::int AS acted,
      count(*) FILTER (WHERE u.created_at > i.sent_at)::int AS signed_up
    FROM inv i LEFT JOIN parties p ON p.id = i.party_id LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN unnest($1::text[], $2::text[]) AS r(id, dial) ON p.phone LIKE r.dial || '%'
    GROUP BY 1, 2 ORDER BY 1, 2`, [ids, ids.map(id => REGIONS[id].dialCode), days])
  const pct = (n, d) => (d ? Math.round((100 * n) / d) : null)
  return rows.map(r => ({ ...r, regionName: REGIONS[r.region]?.name ?? 'Sans numéro', openRate: pct(r.opened, r.sent), actRate: pct(r.acted, r.sent), signupRate: pct(r.signed_up, r.sent) }))
}
adminRoutes.get('/funnel', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365)
  const users = await all(pool, `SELECT region, count(*)::int AS users, count(*) FILTER (WHERE created_at > now() - make_interval(days => $1))::int AS new_users,
    (SELECT count(DISTINCT a.actor_id) FROM audit_events a JOIN users x ON x.id::text = a.actor_id WHERE x.region = users.region AND a.actor_type='user' AND a.created_at > now() - interval '7 days')::int AS active_7d
    FROM users GROUP BY region ORDER BY region`, [days])
  res.json({ days, users: users.map(u => ({ ...u, regionName: REGIONS[u.region]?.name ?? u.region })), links: await linkFunnel(days) })
})

adminRoutes.get('/overview', async (req, res) => {
  const [counts, mismatches, safe] = await Promise.all([
    one(pool, `SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM roles WHERE status='pending')::int AS pending_roles,
      (SELECT count(*) FROM disputes WHERE status IN ('open','proposed'))::int AS disputes, (SELECT count(*) FROM outbox WHERE status='failed')::int AS failed_jobs,
      (SELECT count(*) FROM adjustments WHERE status='proposed')::int AS adjustments, (SELECT count(*) FROM users WHERE frozen)::int AS frozen`),
    reconcile(pool), safeguarding()])
  res.json({ counts, reconciliation: { ok: mismatches.length === 0, mismatches }, safeguarding: safe })
})

adminRoutes.get('/users', async (req, res) => {
  const q = `%${String(req.query.q ?? '').trim()}%`
  res.json({ users: await all(pool, `SELECT u.id, u.name, u.phone, u.region, u.persona, u.kyc_level, u.frozen, u.created_at,
    COALESCE(json_agg(json_build_object('role', r.role, 'status', r.status)) FILTER (WHERE r.role IS NOT NULL), '[]') AS roles
    FROM users u LEFT JOIN roles r ON r.user_id=u.id WHERE u.phone ILIKE $1 OR u.name ILIKE $1 GROUP BY u.id ORDER BY u.created_at DESC LIMIT 50`, [q]) })
})

adminRoutes.get('/users/:id', async (req, res) => {
  const u = await userById(pool, req.params.id)
  if (!u) fail('Introuvable', 404)
  const accounts = await all(pool, `SELECT kind, currency, balance FROM accounts WHERE owner=$1`, [u.id])
  const roles = await all(pool, 'SELECT role, status, created_at FROM roles WHERE user_id=$1', [u.id])
  const events = await all(pool, 'SELECT action, object_type, object_id, created_at, actor_type FROM audit_events WHERE actor_id=$1 OR object_id=$1 ORDER BY id DESC LIMIT 30', [u.id])
  const { pin_hash, ...safe } = u
  res.json({ user: safe, accounts: accounts.map(a => ({ ...a, text: money(a.balance, a.currency) })), roles, events })
})

adminRoutes.post('/users/:id/freeze', async (req, res) => {
  const frozen = Boolean(req.body?.frozen), reason = String(req.body?.reason ?? '').trim()
  if (!reason) fail('Motif requis')
  await tx(async c => {
    await c.query('UPDATE users SET frozen=$2 WHERE id=$1', [req.params.id, frozen])
    if (frozen) await c.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [req.params.id])
    await log(c, req, frozen ? 'user.freeze' : 'user.unfreeze', 'user', req.params.id, { reason })
  })
  res.json({ ok: true })
})

adminRoutes.post('/users/:id/kyc', async (req, res) => {
  const level = Number(req.body?.level), reason = String(req.body?.reason ?? '').trim()
  if (![0, 1, 2].includes(level) || !reason) fail('Niveau (0-2) et motif requis')
  await tx(async c => { await c.query('UPDATE users SET kyc_level=$2 WHERE id=$1', [req.params.id, level]); await log(c, req, 'kyc.level', 'user', req.params.id, { level, reason }) })
  res.json({ ok: true })
})

adminRoutes.post('/users/:id/roles/:role', async (req, res) => {
  const status = String(req.body?.status)
  if (!['active', 'revoked'].includes(status)) fail('Statut invalide')
  if (req.params.role === 'admin' && req.params.id === req.userId) fail('Vous ne pouvez pas modifier votre propre rôle')
  await tx(async c => {
    await c.query(`INSERT INTO roles (user_id, role, status, granted_by) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, role) DO UPDATE SET status=EXCLUDED.status, granted_by=EXCLUDED.granted_by`, [req.params.id, req.params.role, status, req.userId])
    await log(c, req, `role.${status}`, 'user', req.params.id, { role: req.params.role })
    if (req.params.role === 'agent') await notify(c, { userId: req.params.id, template: 'role.agent', text: status === 'active' ? 'Votre agrément d’agent est validé : les opérations clients sont activées.' : 'Votre agrément d’agent a été retiré.' })
  })
  res.json({ ok: true })
})

/* ---------------- disputes ---------------- */

adminRoutes.get('/disputes', async (req, res) => {
  const rows = await all(pool, `SELECT d.*, e.title, e.amount, e.currency, e.payer_party, e.payee_party, pa.name AS payer_name, pb.name AS payee_name
    FROM disputes d JOIN escrows e ON e.id=d.escrow_id JOIN parties pa ON pa.id=e.payer_party JOIN parties pb ON pb.id=e.payee_party
    ORDER BY (d.status='resolved'), d.created_at DESC LIMIT 100`)
  res.json({ disputes: rows.map(d => ({ ...d, amountText: money(d.amount, d.currency) })) })
})

adminRoutes.get('/disputes/:id', async (req, res) => {
  const d = await one(pool, 'SELECT * FROM disputes WHERE id=$1', [req.params.id])
  if (!d) fail('Introuvable', 404)
  const e = await loadEscrow(pool, d.escrow_id)
  const [payer, payee] = await Promise.all([partyById(pool, e.payer_party), partyById(pool, e.payee_party)])
  const stage = e.stage_id ? await one(pool, 'SELECT * FROM job_stages WHERE id=$1', [e.stage_id]) : null
  const evidence = await all(pool, 'SELECT ev.*, p.name AS party_name FROM dispute_evidence ev JOIN parties p ON p.id=ev.party_id WHERE ev.dispute_id=$1 ORDER BY ev.created_at', [d.id])
  res.json({ dispute: d, escrow: { ...e, amountText: money(e.amount, e.currency) }, payer, payee, stage, evidence })
})

adminRoutes.post('/disputes/:id/propose', async (req, res) => {
  const { outcome, payeeAmount, note } = req.body ?? {}
  if (!['release', 'refund', 'split'].includes(outcome) || !String(note ?? '').trim()) fail('Décision et motif requis')
  await tx(async c => {
    const d = await one(c, 'SELECT * FROM disputes WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!d) fail('Litige introuvable', 404)
    const e = await loadEscrow(c, d.escrow_id)
    const proposal = { outcome, note: String(note).slice(0, 500) }
    if (outcome === 'split') {
      const amt = Number(payeeAmount)
      if (!Number.isSafeInteger(amt) || amt <= 0 || amt >= e.amount) fail(`Montant au bénéficiaire entre 1 et ${e.amount - 1} (unités mineures)`)
      proposal.payeeAmount = amt
    }
    await transition(c, 'disputes', d.id, ['open', 'proposed'], 'proposed', { proposal, proposed_by: req.userId })
    await log(c, req, 'dispute.propose', 'dispute', d.id, proposal)
  })
  res.json({ ok: true })
})

adminRoutes.post('/disputes/:id/approve', async (req, res) => {
  await tx(async c => {
    const d = await one(c, 'SELECT * FROM disputes WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!d) fail('Litige introuvable', 404)
    if (d.status !== 'proposed') fail('Aucune proposition à approuver', 409)
    if (d.proposed_by === req.userId) fail('Une autre personne doit approuver cette décision', 403)
    const e = await loadEscrow(c, d.escrow_id)
    const p = d.proposal
    let against = null
    if (p.outcome === 'release') { await releaseEscrow(c, e, 'Litige tranché'); against = e.payer_party }
    else if (p.outcome === 'refund') { await transition(c, 'escrows', e.id, 'disputed', 'refunded'); await refundEscrow(c, e); if (e.stage_id) await escrowHooks.stage.refunded(c, e); if (e.order_id) await escrowHooks.order.refunded(c, e); against = e.payee_party }
    else {
      // Split: the payee gets payeeAmount, the payer gets the rest back.
      await transition(c, 'escrows', e.id, 'disputed', 'released')
      const { deliver } = await import('./modules/shared.js')
      await deliver(c, { source: await sys(c, 'escrow', e.currency), amount: p.payeeAmount, toParty: await partyById(c, e.payee_party), title: `Litige tranché : ${e.title}`, purpose: { escrowId: e.id }, kind: 'escrow_release' })
      await refundEscrow(c, e, e.amount - p.payeeAmount)
      if (e.stage_id) await escrowHooks.stage.released(c, e)
      if (e.order_id) await escrowHooks.order.released(c, e)
    }
    await c.query(`UPDATE disputes SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=now() WHERE id=$1`, [d.id, { ...p, against }, req.userId])
    for (const pid of [e.payer_party, e.payee_party]) await notify(c, { partyId: pid, template: 'dispute.resolved', text: `Litige « ${e.title} » tranché : ${p.note}` })
    await log(c, req, 'dispute.approve', 'dispute', d.id, p)
  })
  res.json({ ok: true })
})

/* ---------------- manual adjustments ---------------- */

adminRoutes.get('/adjustments', async (req, res) => {
  res.json({ adjustments: await all(pool, 'SELECT a.*, u.name, u.region FROM adjustments a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 50') })
})
adminRoutes.post('/adjustments', async (req, res) => {
  const amount = Number(req.body?.amount), reason = String(req.body?.reason ?? '').trim()
  if (!Number.isSafeInteger(amount) || amount === 0 || !reason) fail('Montant (unités mineures, signé) et motif requis')
  const id = newId()
  await tx(async c => {
    if (!await userById(c, req.body?.userId)) fail('Utilisateur introuvable', 404)
    await c.query(`INSERT INTO adjustments (id, user_id, amount, reason, status, proposed_by) VALUES ($1,$2,$3,$4,'proposed',$5)`, [id, req.body.userId, amount, reason, req.userId])
    await log(c, req, 'adjustment.propose', 'adjustment', id, { amount, reason })
  })
  res.json({ id })
})
adminRoutes.post('/adjustments/:id/approve', async (req, res) => {
  await tx(async c => {
    const a = await one(c, 'SELECT * FROM adjustments WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!a) fail('Ajustement introuvable', 404)
    if (a?.status !== 'proposed') fail('Aucun ajustement à approuver', 409)
    if (a.proposed_by === req.userId) fail('Une autre personne doit approuver cet ajustement', 403)
    const user = await userById(c, a.user_id), wallet = await walletOf(c, user)
    await post(c, { kind: 'adjustment', idem: `adjustment:${a.id}`, lines: [{ account: await sys(c, 'adjustments', wallet.currency), amount: -a.amount }, { account: wallet, amount: a.amount, title: `Correction : ${a.reason}`, icon: 'wrench' }] })
    await c.query(`UPDATE adjustments SET status='approved', approved_by=$2 WHERE id=$1`, [a.id, req.userId])
    await log(c, req, 'adjustment.approve', 'adjustment', a.id, { amount: a.amount })
  })
  res.json({ ok: true })
})

/* ---------------- operations ---------------- */

adminRoutes.get('/outbox', async (req, res) => {
  res.json({ jobs: await all(pool, `SELECT id, kind, status, attempts, last_error, created_at FROM outbox WHERE status = ANY($1) ORDER BY id DESC LIMIT 100`, [[String(req.query.status ?? 'failed')]]) })
})
adminRoutes.post('/outbox/:id/retry', async (req, res) => {
  await tx(async c => { await c.query(`UPDATE outbox SET status='pending', attempts=0, next_at=now() WHERE id=$1 AND status='failed'`, [req.params.id]); await log(c, req, 'outbox.retry', 'outbox', req.params.id) })
  res.json({ ok: true })
})
// Cuts every link sent to a phone number, for example after a link was forwarded to the wrong person.
// The people concerned can be sent fresh links from the app.
adminRoutes.post('/links/revoke', async (req, res) => {
  const phone = String(req.body?.phone ?? '').trim(), reason = String(req.body?.reason ?? '').trim()
  if (!reason) fail('Motif requis')
  const revoked = await tx(async c => {
    const party = await one(c, 'SELECT * FROM parties WHERE phone=$1', [phone])
    if (!party) fail('Aucune personne avec ce numéro', 404)
    const r = await c.query('UPDATE links SET revoked_at=now() WHERE party_id=$1 AND revoked_at IS NULL AND expires_at > now()', [party.id])
    await log(c, req, 'links.revoke', 'party', party.id, { reason, count: r.rowCount })
    return r.rowCount
  })
  res.json({ revoked })
})

// CSV exports for accounting, a partner's due diligence or a regulator. Every export is written to the audit log.
// Cells that a spreadsheet would run as a formula are neutralised.
const cell = v => {
  if (v === null || v === undefined) return ''
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/^[=+\-@\t\r]/.test(s) && typeof v !== 'number' && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const toCsv = rows => (rows.length ? [Object.keys(rows[0]).join(','), ...rows.map(r => Object.values(r).map(cell).join(','))].join('\r\n') + '\r\n' : '')
const EXPORTS = {
  users: `SELECT u.id, u.phone, u.name, u.region, u.persona, u.kyc_level, u.frozen, u.created_at, u.terms_version, u.terms_accepted_at, u.closure_requested_at
    FROM users u WHERE u.created_at >= $1 AND u.created_at < $2 ORDER BY u.created_at`,
  recorded_payments: `SELECT r.id, r.created_at, r.confirmed_at, r.status, r.amount, r.currency, r.purpose, r.ref, pa.phone AS payer_phone, pa.name AS payer_name, pb.phone AS payee_phone, pb.name AS payee_name
    FROM recorded_payments r JOIN parties pa ON pa.id=r.payer_party JOIN parties pb ON pb.id=r.payee_party WHERE r.created_at >= $1 AND r.created_at < $2 ORDER BY r.created_at`,
  ledger: `SELECT p.id AS posting_id, p.created_at, e.id AS entry_id, e.kind AS entry_kind, a.owner AS account_owner, a.kind AS account_kind, a.currency, p.amount, p.title, p.ref
    FROM postings p JOIN entries e ON e.id=p.entry_id JOIN accounts a ON a.id=p.account_id WHERE p.created_at >= $1 AND p.created_at < $2 ORDER BY p.id`,
  disputes: `SELECT d.id, d.created_at, d.resolved_at, d.status, d.reason, e.title, e.amount, e.currency, d.resolution
    FROM disputes d JOIN escrows e ON e.id=d.escrow_id WHERE d.created_at >= $1 AND d.created_at < $2 ORDER BY d.created_at`,
  audit: `SELECT id, created_at, actor_type, actor_id, action, object_type, object_id, ip FROM audit_events WHERE created_at >= $1 AND created_at < $2 ORDER BY id`,
}
adminRoutes.get('/export/:set', async (req, res) => {
  const sql = Object.hasOwn(EXPORTS, req.params.set) ? EXPORTS[req.params.set] : null
  if (!sql) fail('Export inconnu', 404)
  const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? new Date(`${v}T00:00:00Z`) : null)
  const from = day(req.query.from) ?? new Date(0), to = day(req.query.to) ? new Date(day(req.query.to).getTime() + 86400000) : new Date(Date.now() + 86400000)
  const rows = await all(pool, sql, [from, to])
  await log(pool, req, 'export', 'export', req.params.set, { from: req.query.from ?? null, to: req.query.to ?? null, rows: rows.length })
  res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="nexus-${req.params.set}-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send('\uFEFF' + toCsv(rows))
})

adminRoutes.get('/audit', async (req, res) => {
  res.json({ events: await all(pool, `SELECT * FROM audit_events WHERE ($1 = '' OR actor_id=$1 OR object_id=$1) AND ($2 = '' OR action LIKE $2 || '%') ORDER BY id DESC LIMIT 200`, [String(req.query.who ?? ''), String(req.query.action ?? '')]) })
})

export { REGIONS as _regions, CURRENCIES as _currencies, mask as _mask }
