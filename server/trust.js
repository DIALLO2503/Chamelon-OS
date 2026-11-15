// Trust badges: milestones earned from commitments other people confirmed, never from what the person declares.
// Private by default (like the score itself); the person may choose to show the earned ones on the pages the people they
// deal with open from a link (a buyer, a client, a worker), so trust built on Nexus becomes visible where it matters.
// The score value is never shown to anyone else: only the badge names.
import { one } from './db.js'
import { mask } from './core.js'

const ORDER_SOLD = ['paid', 'delivered', 'completed']

// s: the result of computeScore (raw counts). Each badge: earned or not, and how far along (have / need).
export async function computeBadges(client, user, party, s) {
  const sold = (await one(client, `SELECT count(*)::int AS n FROM orders WHERE seller_id=$1 AND status = ANY($2)`, [user.id, ORDER_SOLD])).n
  const crew = await one(client, `SELECT count(DISTINCT date_trunc('week', created_at)) FILTER (WHERE status='confirmed')::int AS weeks,
      count(*) FILTER (WHERE status='rejected')::int AS refused
    FROM recorded_payments WHERE payer_party=$1 AND ref LIKE 'crew:%' AND created_at > now() - interval '90 days'`, [party.id])
  const clean = s.lost === 0
  const badges = [
    { id: 'confirmed', icon: 'badge-check', label: 'Paiements confirmés', text: '10 paiements confirmés par au moins 5 personnes différentes',
      have: Math.min(s.confirmed, 10) + Math.min(s.people, 5), need: 15, earned: s.confirmed >= 10 && s.people >= 5 },
    { id: 'seller', icon: 'shopping-bag', label: 'Vente certifiée', text: '10 ventes payées, aucun litige perdu',
      have: Math.min(sold, 10), need: 10, earned: sold >= 10 && clean, relevant: sold > 0 },
    { id: 'boss', icon: 'hard-hat', label: 'Patron fiable', text: 'Paie de l’équipe confirmée sur 3 semaines différentes en 3 mois, sans refus',
      have: Math.min(crew.weeks, 3), need: 3, earned: crew.weeks >= 3 && crew.refused === 0, relevant: crew.weeks > 0 },
    { id: 'saver', icon: 'users-round', label: 'Cotisant régulier', text: '3 cotisations versées, aucun retard',
      have: Math.min(s.contribs, 3), need: 3, earned: s.contribs >= 3 && s.late === 0, relevant: s.contribs > 0 },
    { id: 'word', icon: 'shield-check', label: 'Parole tenue', text: '5 acomptes ou étapes payés, aucun litige perdu',
      have: Math.min(s.kept, 5), need: 5, earned: s.kept >= 5 && clean, relevant: s.kept > 0 },
  ]
  // A badge in progress is only worth showing when the person has started on it (the first one is universal).
  return badges.filter(b => b.earned || b.relevant !== false).map(({ relevant, ...b }) => b)
}

// What a link page shows about the person the visitor deals with: their earned badges, if they chose to show them.
export async function publicTrust(client, partyId, computeScore) {
  const user = await one(client, 'SELECT u.* FROM users u JOIN parties p ON p.user_id = u.id WHERE p.id=$1', [partyId])
  if (!user?.share_badges) return null
  const party = await one(client, 'SELECT * FROM parties WHERE id=$1', [partyId])
  const earned = (await computeBadges(client, user, party, await computeScore(client, user, party))).filter(b => b.earned)
  if (!earned.length) return null
  return { name: mask(user.name), badges: earned.map(b => ({ icon: b.icon, label: b.label, text: b.text })) }
}
