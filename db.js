import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'

// BIGINT columns hold minor units; they always fit in a JS safe integer at the amounts the ledger allows.
pg.types.setTypeParser(20, v => {
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new Error('bigint out of safe range')
  return n
})

// NUMERIC (e.g. SUM over BIGINT) becomes a number too, never a string that would concatenate.
pg.types.setTypeParser(1700, v => {
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new Error('numeric out of safe range')
  return n
})

// DATE columns stay 'YYYY-MM-DD' strings: no timezone shifts.
pg.types.setTypeParser(1082, v => v)

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 })

// Every query goes through a client: either the transaction's client or the pool.
export const q = (client, sql, params = []) => client.query(sql, params)
export const one = async (client, sql, params) => (await client.query(sql, params)).rows[0]
export const all = async (client, sql, params) => (await client.query(sql, params)).rows

export async function tx(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// Compare-and-set state change: fails unless exactly one row was in the expected state.
export async function transition(client, table, id, from, to, extra = {}) {
  const sets = ['status = $3', ...Object.keys(extra).map((k, i) => `${k} = $${i + 4}`)]
  const froms = Array.isArray(from) ? from : [from]
  const res = await client.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 AND status = ANY($2) RETURNING *`, [id, froms, to, ...Object.values(extra)])
  if (res.rowCount !== 1) {
    const err = new Error('Cette action n’est plus possible')
    err.status = 409
    throw err
  }
  return res.rows[0]
}

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export async function migrate() {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name))
  for (const file of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue
    await tx(async c => {
      await c.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'))
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
    })
  }
}
