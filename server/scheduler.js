// Periodic work. A Postgres advisory lock makes sure only one process runs a tick, however many servers are up.
import { pool, tx, one, all } from './db.js'
import { log } from './log.js'
import { reconcile } from './ledger.js'
import { notify, createLink } from './rails.js'
import { money, longDate } from './core.js'
import { autoReleaseDue, releaseEscrow } from './modules/escrow.js'
import { runDueSchedules } from './modules/remit.js'
import { dueTontines, membersOf } from './modules/tontine.js'
import { settleCommissions } from './modules/work.js'
import { collectDueAdvances } from './modules/advance.js'
import { safeguarding } from './admin.js'

const LOCK_ID = 7340021

export async function autoRelease() {
  for (const e of await autoReleaseDue(pool)) {
    try { await tx(async c => { const fresh = await one(c, 'SELECT * FROM escrows WHERE id=$1 FOR UPDATE', [e.id]); if (fresh.status === 'held') await releaseEscrow(c, fresh, 'Versement automatique') }) }
    catch (err) { log.error({ err, escrow: e.id }, 'auto-release failed') }
  }
}

export async function tontineReminders() {
  for (const t of await dueTontines(pool)) {
    await tx(async c => {
      for (const m of await membersOf(c, t)) {
        if (await one(c, 'SELECT 1 FROM tontine_contribs WHERE tontine_id=$1 AND round=$2 AND party_id=$3', [t.id, t.round, m.party_id])) continue
        const link = await createLink(c, { kind: 'tontine', refId: t.id, partyId: m.party_id, days: 7 })
        await notify(c, { partyId: m.party_id, template: 'tontine.due', text: `Rappel « ${t.name} » : cotisation de ${money(t.amount, t.currency)} attendue avant le ${longDate(t.next_due)}.`, link, dedupe: `due:${t.id}:${t.round}:${m.party_id}:${new Date().toISOString().slice(0, 10)}` })
      }
    })
  }
}

export async function checkLedger() {
  const [mismatches, safe] = await Promise.all([reconcile(pool), safeguarding()])
  const bad = safe.filter(s => !s.ok)
  if (mismatches.length || bad.length) {
    log.error({ mismatches, safeguarding: bad }, 'LEDGER ALERT: reconciliation or safeguarding failed')
    const admins = await all(pool, `SELECT user_id FROM roles WHERE role='admin' AND status='active'`)
    await tx(async c => { for (const a of admins) await notify(c, { userId: a.user_id, template: 'alert.ledger', text: 'Alerte : écart de rapprochement ou de cantonnement détecté. Voir la console d’administration.', dedupe: `ledger-alert:${a.user_id}:${new Date().toISOString().slice(0, 13)}` }) })
  }
  return { mismatches, safeguarding: safe }
}

async function tick(hourly) {
  const c = await pool.connect()
  try {
    const { locked } = (await c.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID])).rows[0]
    if (!locked) return
    try {
      await pool.query(`UPDATE intents SET status='expired' WHERE status='quoted' AND expires_at < now()`)
      await autoRelease()
      await runDueSchedules()
      if (hourly) { await tontineReminders(); await settleCommissions(); await collectDueAdvances(); await checkLedger() }
    } finally { await c.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]) }
  } catch (err) { log.error({ err }, 'scheduler tick failed') } finally { c.release() }
}

export function startScheduler() {
  let n = 0
  const run = () => tick(n++ % 60 === 0)
  run()
  return setInterval(run, 60_000).unref()
}
