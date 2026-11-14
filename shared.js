import { randomBytes } from 'node:crypto'
import { one, all, transition } from '../db.js'
import { REGIONS, CURRENCIES } from '../catalog.js'
import { fail, newId, fmt, mask, convert } from '../core.js'
import { notify, createLink, shareFor } from '../rails.js'
import { partyById, userById, walletOf } from '../context.js'
import { post, expand, legs, sys } from '../ledger.js'
import { startPayout } from '../rails.js'

export const amountField = (label = 'Montant', extra = {}) => ({ name: 'amount', label, type: 'amount', ...extra })
export const phoneField = (label, extra = {}) => ({ name: 'phone', label, type: 'tel', hint: "Depuis un autre pays, commencez par l'indicatif (+…).", ...extra })
export const textField = (name, label, extra = {}) => ({ name, label, type: 'text', ...extra })
export const code10 = () => randomBytes(8).toString('base64url').replace(/[-_]/g, '').slice(0, 10).toUpperCase()

export const regionOfPhone = phone => Object.keys(REGIONS).find(id => phone.startsWith(REGIONS[id].dialCode))

// Where a party's money lands: their own wallet if they have an account in a held-custody country, otherwise
// a payout to their mobile money in their country's currency. Returns { currency, region }.
export async function destinationOf(client, party) {
  const user = party.user_id ? await userById(client, party.user_id) : null
  const region = user?.region ?? regionOfPhone(party.phone)
  if (!region) fail('Pays du bénéficiaire non pris en charge')
  return { user, region, currency: REGIONS[region].currency.code, wallet: user && REGIONS[region].custody === 'held' }
}

// Cross-currency movements are only allowed on corridors the payer's country has opened, and only in held custody.
export function assertCorridor(ctx, toRegion, product) {
  if (toRegion === ctx.user.region) return
  if (!ctx.held) fail('Les paiements vers un autre pays ne sont pas encore ouverts dans votre pays')
  if (!ctx.region.corridors.includes(toRegion)) fail(`Les paiements vers ${REGIONS[toRegion].name} ne sont pas ouverts depuis ${ctx.region.name}`)
  if (!['remit', 'escrow'].includes(product)) fail('Ce type de paiement ne peut pas traverser les frontières')
}

// Pays `amount` (in source currency) out of a system or user account to a party: wallet credit or mobile-money payout.
export async function deliver(client, { source, amount, toParty, title, purpose, kind }) {
  const dest = await destinationOf(client, toParty)
  const received = convert(amount, source.currency, dest.currency, 'down')
  if (dest.wallet) {
    const wallet = await walletOf(client, dest.user)
    await post(client, { kind, lines: await expand(client, [legs(source, wallet, amount, received, { to: { title, icon: 'arrow-down-left' } })]) })
    return { received, currency: dest.currency, via: 'wallet' }
  }
  // Payout in the recipient's currency: convert inside Nexus first, then pay out from a same-currency account.
  let from = source
  if (source.currency !== dest.currency) {
    from = await sys(client, 'fx_out', dest.currency)
    await post(client, { kind, lines: await expand(client, [legs(source, from, amount, received)]) })
  }
  await startPayout(client, { source: from, amount: received, phone: toParty.phone, partyId: toParty.id, title, purpose })
  return { received, currency: dest.currency, via: 'payout' }
}

/* ---------------- payments recorded outside Nexus (custody stage 1) ---------------- */

export const onRecordedConfirmed = {}
// Undo hooks when the other side says the payment did not happen: the object returns to its unpaid state.
export const onRecordedRejected = {}

// One side records a payment; the other side confirms it, in the app or from a link. Only confirmed payments count.
export async function recordPayment(ctx, { payerParty, payeeParty, amount, currency, purpose, ref = null }) {
  const id = newId()
  const other = payerParty.id === ctx.party.id ? payeeParty : payerParty
  await ctx.client.query(`INSERT INTO recorded_payments (id, payer_party, payee_party, amount, currency, purpose, ref, recorded_by, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'claimed')`,
    [id, payerParty.id, payeeParty.id, amount, currency, purpose, ref, ctx.party.id])
  const url = await createLink(ctx.client, { kind: 'recorded', refId: id, partyId: other.id })
  const verb = payerParty.id === ctx.party.id ? `dit vous avoir payé` : `dit avoir reçu de vous`
  const text = `${mask(ctx.user.name)} ${verb} ${fmt(amount, CURRENCIES[currency])} (${purpose}). Confirmez ou refusez :`
  await notify(ctx.client, { partyId: other.id, template: 'recorded.claim', text, link: url })
  return { id, share: shareFor(text, url) }
}

export async function settleRecorded(client, id, party, accept) {
  const rp = await one(client, 'SELECT * FROM recorded_payments WHERE id=$1 FOR UPDATE', [id])
  if (!rp || (rp.payer_party !== party.id && rp.payee_party !== party.id)) fail('Introuvable', 404)
  if (rp.recorded_by === party.id) fail('Seule l’autre personne peut confirmer ce paiement', 403)
  const updated = await transition(client, 'recorded_payments', id, 'claimed', accept ? 'confirmed' : 'rejected', accept ? { confirmed_at: new Date() } : {})
  if (rp.ref) {
    const [type, refId] = rp.ref.split(':')
    await (accept ? onRecordedConfirmed : onRecordedRejected)[type]?.(client, refId, updated)
  }
  const recorder = await partyById(client, rp.recorded_by)
  await notify(client, { partyId: recorder.id, template: 'recorded.result', text: `${mask(party.name)} a ${accept ? 'confirmé' : 'refusé'} le paiement de ${fmt(rp.amount, CURRENCIES[rp.currency])} (${rp.purpose}).` })
  return updated
}

export async function pendingForMe(ctx) {
  return all(ctx.client, `SELECT r.*, pa.name AS payer_name, pb.name AS payee_name FROM recorded_payments r
    JOIN parties pa ON pa.id=r.payer_party JOIN parties pb ON pb.id=r.payee_party
    WHERE (r.payer_party=$1 OR r.payee_party=$1) AND r.recorded_by<>$1 AND r.status='claimed' ORDER BY r.created_at DESC`, [ctx.party.id])
}

export const recordedRow = (ctx, r) => {
  const incoming = r.payee_party === ctx.party.id
  return {
    id: r.id, title: r.purpose, sub: `${mask(incoming ? r.payer_name : r.payee_name)} ${incoming ? 'dit vous avoir payé' : 'dit avoir reçu de vous'}`,
    value: fmt(r.amount, CURRENCIES[r.currency]), status: 'À confirmer', tone: 'wait',
    actions: [{ id: 'confirmRecorded', label: 'Confirmer', tone: 'primary' }, { id: 'rejectRecorded', label: 'Refuser' }],
  }
}

// A collection that arrived but cannot be applied (duplicate, late, cancelled): send the money back to the payer.
export async function returnCollection(client, op, reason) {
  const returns = await sys(client, 'returns', op.currency)
  await post(client, { kind: 'collection_return', idem: `return:${op.id}`, lines: [{ account: await sys(client, 'rail', op.currency), amount: -op.amount }, { account: returns, amount: op.amount }] })
  await startPayout(client, { source: returns, amount: op.amount, phone: op.phone, partyId: op.party_id, title: `Remboursement : ${reason}`, purpose: { returnOf: op.id } })
}
