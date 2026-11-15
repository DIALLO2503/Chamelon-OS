// In-person collection ("Encaisser") and earned-wage advances, end to end against PostgreSQL.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool, one, resetDb, user, act, quote, bal, healthy, settleAll, engine, partyOf } from './helpers.js'

const { PRICING } = await import('../catalog.js')
const { collectDueAdvances } = await import('../modules/advance.js')
const { money } = await import('../core.js')
const xof = n => money(n, 'XOF')

before(resetDb)
after(() => pool.end())

const sale = id => one(pool, 'SELECT * FROM pos_sales WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [id])
const lender = cur => one(pool, `SELECT balance FROM accounts WHERE owner='system' AND kind='lender' AND currency=$1`, [cur])

test('collect in person, held custody: the customer approves on their phone, the merchant is credited by the partner', async () => {
  const seller = await user('SN', 'seller'), customer = '+221770009911'
  const exp = (await engine.me(seller.id)).experience
  assert.deepEqual(exp.actions.filter(a => a.label === 'Encaisser').map(a => a.action), ['charge'], 'one "Encaisser" button, the held one')

  await act(seller, 'pos', 'charge', { amount: '15000', label: 'Robe wax', phone: customer })
  assert.equal((await sale(seller.id)).status, 'pending')
  assert.equal(await bal(seller), 0, 'nothing credited before the partner confirms')
  await settleAll()
  assert.equal((await sale(seller.id)).status, 'paid')
  assert.equal(await bal(seller), 15000)

  await act(seller, 'pos', 'charge', { amount: '8000', label: 'Pagne', phone: customer })
  await settleAll('failed')
  assert.equal((await sale(seller.id)).status, 'failed', 'a refused request is shown as failed')
  assert.equal(await bal(seller), 15000)

  const view = await engine.moduleView(seller.id, 'pos')
  assert.equal(view.blocks[0].items[0].value, '1', 'one paid sale today')
  await assert.rejects(act(seller, 'pos', 'charge', { amount: '1000', label: 'X', phone: seller.phone }), /numéro du client/)
  await healthy(assert)
})

test('collect in person, record custody: the customer confirms the scanned payment, nothing moves through Nexus', async () => {
  const seller = await user('MA', 'seller'), customer = await user('MA', 'parent')
  const exp = (await engine.me(seller.id)).experience
  assert.deepEqual(exp.actions.filter(a => a.label === 'Encaisser').map(a => a.action), ['chargeRecorded'])

  const r = await act(seller, 'pos', 'chargeRecorded', { amount: '350', label: 'Caftan', phone: customer.phone })
  assert.match(r.done.share.url, /\/l\//, 'a link / code for the customer to confirm')
  const s = await sale(seller.id)
  await act(customer, 'wallet', 'confirmRecorded', {}, s.recorded_id)
  assert.equal((await sale(seller.id)).status, 'paid')

  await act(seller, 'pos', 'chargeRecorded', { amount: '120', label: 'Ceinture', phone: customer.phone })
  await act(customer, 'wallet', 'rejectRecorded', {}, (await sale(seller.id)).recorded_id)
  assert.equal((await sale(seller.id)).status, 'rejected')
  assert.equal(await one(pool, `SELECT 1 FROM accounts WHERE owner=$1`, [seller.id]), undefined, 'record custody: no wallet, no ledger')
})

test('advance: eligibility from money actually received, flat fee, one at a time, repaid by hand and on the due date', async () => {
  const minDays = PRICING.advance.minEarningDays
  PRICING.advance.minEarningDays = 1 // earnings in a test all land today
  try {
    const driver = await user('SN', 'driver'), client = await user('SN', 'seller', { fund: 400000 })
    let form = await engine.actionForm(driver.id, 'advance', 'draw')
    assert.ok(form.blocked && /jours d’activité/.test(form.info), 'a new account waits')
    await pool.query(`UPDATE users SET created_at = now() - interval '90 days' WHERE id=$1`, [driver.id])
    form = await engine.actionForm(driver.id, 'advance', 'draw')
    assert.ok(form.blocked && /jours de revenus/.test(form.info), 'top-ups are not earnings')

    await act(client, 'wallet', 'send', { amount: '300000', phone: driver.phone, note: 'Courses du mois' })
    form = await engine.actionForm(driver.id, 'advance', 'draw')
    assert.ok(form.info.startsWith(`Jusqu’à ${xof(30000)}.`), '30 % of 100 000 a month')
    await assert.rejects(act(driver, 'advance', 'draw', { amount: '50000' }), /Au plus 30\s000/)

    const q = await quote(driver, 'advance', 'draw', { amount: '30000' })
    assert.deepEqual(q.review.lines.slice(0, 3).map(l => l[1]), [xof(30000), xof(1000), xof(31000)], 'fee shown before confirming')
    await engine.confirmIntent(driver.id, q.intentId, { pin: '2580', idem: crypto.randomUUID() })
    assert.equal(await bal(driver), 330000)
    assert.equal((await lender('XOF')).balance, -30000)
    await healthy(assert)

    form = await engine.actionForm(driver.id, 'advance', 'draw')
    assert.ok(form.blocked && /en cours/.test(form.info), 'one advance at a time')

    await act(driver, 'advance', 'repay', { amount: '10000' })
    let a = await one(pool, 'SELECT * FROM advances WHERE user_id=$1', [driver.id])
    assert.equal(a.repaid, 10000)

    // Due date: what the wallet holds is taken, fee included; the lender ends with its fee.
    await pool.query(`UPDATE advances SET due_at = now() - interval '1 minute' WHERE id=$1`, [a.id])
    await collectDueAdvances()
    a = await one(pool, 'SELECT * FROM advances WHERE id=$1', [a.id])
    assert.equal(a.status, 'repaid'); assert.equal(a.repaid, 31000)
    assert.equal(await bal(driver), 299000)
    assert.equal((await lender('XOF')).balance, 1000)
    await healthy(assert)
  } finally { PRICING.advance.minEarningDays = minDays }
})

test('advance: an empty wallet at the due date is collected later, without penalty; record countries have no advances', async () => {
  const minDays = PRICING.advance.minEarningDays
  PRICING.advance.minEarningDays = 1
  try {
    const worker = await user('AE', 'worker'), boss = await user('AE', 'trader', { fund: 30000 })
    await pool.query(`UPDATE users SET created_at = now() - interval '90 days' WHERE id=$1`, [worker.id])
    await act(boss, 'wallet', 'send', { amount: '9000', phone: worker.phone })
    await act(worker, 'advance', 'draw', { amount: '800' }) // 30 % of 3 000 AED a month = 900 AED max
    await act(worker, 'wallet', 'withdraw', { amount: String((await bal(worker)) / 100 - 5) }) // spends almost everything
    await settleAll()
    const a = await one(pool, 'SELECT * FROM advances WHERE user_id=$1', [worker.id])
    await pool.query(`UPDATE advances SET due_at = now() - interval '1 minute' WHERE id=$1`, [a.id])
    await collectDueAdvances()
    let fresh = await one(pool, 'SELECT * FROM advances WHERE id=$1', [a.id])
    assert.equal(fresh.repaid, 500, 'takes the 5 AED left'); assert.equal(fresh.status, 'active')
    assert.equal(fresh.amount + fresh.fee, 80000 + 1500, 'no late fee added')
    const note = await one(pool, `SELECT text FROM notifications WHERE user_id=$1 AND template='advance.due'`, [worker.id])
    assert.match(note.text, /Pas de pénalité/)

    await act(boss, 'wallet', 'send', { amount: '1000', phone: worker.phone })
    await collectDueAdvances()
    fresh = await one(pool, 'SELECT * FROM advances WHERE id=$1', [a.id])
    assert.equal(fresh.status, 'repaid')
    await healthy(assert)

    const ma = await user('MA', 'ouvrier')
    await assert.rejects(engine.moduleView(ma.id, 'advance'), /indisponible/, 'no advances where no money passes through Nexus')
  } finally { PRICING.advance.minEarningDays = minDays }
})
