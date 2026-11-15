// Sandbox only: six months of past activity for a few demo accounts, so the home trend and money alerts have something to show.
// Record custody (Morocco) only: confirmed direct payments, exactly what the confirmation flow leaves behind, with past dates.
// Nothing here runs outside `seedDemo()`, which refuses to run outside the sandbox.
import { randomUUID } from 'node:crypto'
import { tx, one } from './db.js'
import { partyByPhone } from './context.js'

const DAY = 86400000
const at = (daysAgo, hour) => { const d = new Date(Date.now() - daysAgo * DAY); d.setHours(hour, 15 + (daysAgo * 7) % 40, 0, 0); return d.toISOString() }
const isoDow = daysAgo => ((new Date(Date.now() - daysAgo * DAY).getDay() + 6) % 7) + 1 // 1 = Monday … 7 = Sunday

// Small deterministic generator: the demo looks the same after every reseed.
function rng(seed) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}
const pick = (r, list) => list[Math.floor(r() * list.length)]
const round = (n, step) => Math.max(step, Math.round(n / step) * step)

async function customers(c, prefix, names) {
  const out = []
  for (const [i, name] of names.entries()) out.push(await partyByPhone(c, `${prefix}${String(100 + i).padStart(4, '0')}`, name))
  return out
}

async function recorded(c, { payer, payee, amount, purpose, recordedBy, when, ref = null }) {
  await c.query(`INSERT INTO recorded_payments (id, payer_party, payee_party, amount, currency, purpose, ref, recorded_by, status, created_at, confirmed_at)
    VALUES ($1,$2,$3,$4,'MAD',$5,$6,$7,'confirmed',$8,$8)`, [randomUUID(), payer.id, payee.id, amount, purpose, ref, recordedBy.id, when])
}

// Salma (online seller): sales grow month after month, Fridays and Saturdays are the strong days, a weekly supplier payment.
async function salma(c, me) {
  const r = rng(11)
  const buyers = await customers(c, '+21260001', ['Imane Chraibi', 'Nadia Alaoui', 'Sara Bennis', 'Kenza Idrissi', 'Leila Fassi', 'Houda Tahiri', 'Meryem Saadi', 'Rim Lahlou'])
  const supplier = await partyByPhone(c, '+212600019000', 'Atelier Derb Omar')
  const items = ['Caftan brodé', 'Djellaba lin', 'Takchita', 'Robe soirée', 'Gandoura', 'Sac brodé']
  for (let d = 175; d >= 1; d--) {
    const dow = isoDow(d)
    if (dow === 7) continue
    const growth = 1 + (175 - d) / 260
    const sales = Math.round((dow >= 5 ? 3 : 1) * growth * (0.6 + r()))
    for (let i = 0; i < sales; i++) await recorded(c, { payer: pick(r, buyers), payee: me, amount: round((250 + r() * 650) * 100, 1000), purpose: pick(r, items), recordedBy: me, when: at(d, 10 + i) })
    if (dow === 2) await recorded(c, { payer: me, payee: supplier, amount: round((1400 + r() * 900) * growth * 100, 5000), purpose: 'Tissus et broderie', recordedBy: me, when: at(d, 18) })
  }
}

// Hassan (maâllem): steady client payments, but this month materials and crew cost more than what came in.
async function hassan(c, me) {
  const r = rng(23)
  const clients = await customers(c, '+21260002', ['Famille Berrada', 'Villa Anfa', 'Café Bab Doukkala', 'Riad Zitoun', 'M. Kettani'])
  const supplier = await partyByPhone(c, '+212600029000', 'Matériaux Sidi Moumen')
  const crew = await customers(c, '+21260004', ['Rachid Ouahbi', 'Mustapha Lahlou'])
  for (let d = 170; d >= 1; d--) {
    const dow = isoDow(d)
    if (dow === 7) continue
    const thisMonth = new Date(Date.now() - d * DAY).getMonth() === new Date().getMonth()
    if (dow === 4 || (dow === 1 && r() > 0.5)) await recorded(c, { payer: pick(r, clients), payee: me, amount: round((thisMonth ? 900 : 2400 + r() * 1800) * 100, 5000), purpose: 'Situation de travaux', recordedBy: me, when: at(d, 17) })
    if (dow === 6) await recorded(c, { payer: me, payee: supplier, amount: round((thisMonth ? 4200 : 1500 + r() * 700) * 100, 5000), purpose: 'Ciment, sable, carrelage', recordedBy: me, when: at(d, 9) })
    // Friday payday for two workers over the last 3 months, each confirmed by the worker (what "Payer l'équipe" leaves behind).
    if (dow === 5 && d <= 90) for (const w of crew) await recorded(c, { payer: me, payee: w, amount: 25000, purpose: 'Paie de la semaine', recordedBy: me, when: at(d, 18), ref: `crew:hist-${d}` })
  }
}

// Brahim (moul hanout): many small daily takings, a supplier invoice every two weeks.
async function brahim(c, me) {
  const r = rng(37)
  const clients = await customers(c, '+21260003', ['Voisin Rachid', 'Mme Amrani', 'Hamid', 'Fatima Zahra', 'Omar le livreur'])
  const supplier = await partyByPhone(c, '+212600039000', 'Grossiste Derb Sultan')
  for (let d = 170; d >= 1; d--) {
    for (let i = 0; i < 2 + Math.floor(r() * 3); i++) await recorded(c, { payer: pick(r, clients), payee: me, amount: round((40 + r() * 160) * 100, 500), purpose: 'Courses', recordedBy: me, when: at(d, 8 + i * 3) })
    if (d % 14 === 3) await recorded(c, { payer: me, payee: supplier, amount: round((1800 + r() * 600) * 100, 5000), purpose: 'Réassort', recordedBy: me, when: at(d, 7) })
  }
}

// Held-custody accounts get no backdated history: the ledger is append-only (a trigger forbids changing postings),
// so their trend fills up from real activity, starting with what the rest of the seed does today.
// Salma: a dozen past orders paid directly and completed, as the order flow leaves them (Vente certifiée badge).
async function salmaOrders(c, me) {
  const r = rng(13)
  const buyers = await customers(c, '+21260001', ['Imane Chraibi', 'Nadia Alaoui', 'Sara Bennis', 'Kenza Idrissi', 'Leila Fassi', 'Houda Tahiri'])
  for (let i = 0; i < 12; i++) {
    const d = 60 - i * 5, buyer = pick(r, buyers)
    await c.query(`INSERT INTO orders (id, seller_id, item, amount, currency, buyer_party, customer_name, code, mode, status, paid_via, created_at, paid_at)
      VALUES ($1,$2,$3,$4,'MAD',$5,$6,$7,'recorded','completed','direct',$8,$8)`,
      [randomUUID(), me.user_id, pick(r, ['Caftan brodé', 'Djellaba lin', 'Takchita', 'Robe soirée']), round((300 + r() * 700) * 100, 1000), buyer.id, buyer.name, `HIST${String(i).padStart(4, '0')}SALMA`, at(d, 14)])
  }
}

export async function seedHistory(u) {
  await tx(async c => {
    const party = async key => one(c, 'SELECT * FROM parties WHERE user_id=$1', [u[key].id])
    await salma(c, await party('salma'))
    await salmaOrders(c, await party('salma'))
    await hassan(c, await party('hassan'))
    await brahim(c, await party('brahim'))
    // These three show their badges on the pages their buyers, clients and workers open.
    await c.query('UPDATE users SET share_badges=true WHERE id = ANY($1)', [[u.salma.id, u.fatou.id, u.hassan.id]])
  })
}
