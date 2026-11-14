// Pages for people who do not have the app, opened from a WhatsApp link. Viewing needs only the link (names are masked);
// anything that commits the person needs a code sent to the phone the link was made for. Payments go through the partner
// from the payer's own mobile money.
import { Router } from 'express'
import { pool, tx, one, all, transition } from './db.js'
import { REGIONS, CURRENCIES } from './catalog.js'
import { fail, money, mask, normalizePhone, longDate, newId } from './core.js'
import { audit, partyById } from './context.js'
import { resolveLink, notify } from './rails.js'
import { issueOtp, consumeOtp } from './auth.js'
import { settleRecorded, recordPayment, regionOfPhone } from './modules/shared.js'
import { loadEscrow, fundByCollection, releaseEscrow, openDispute } from './modules/escrow.js'
import { stagesOf, jobOps } from './modules/jobs.js'
import { orderOps } from './modules/commerce.js'
import { tontineOps, membersOf } from './modules/tontine.js'
import { owedBy } from './modules/commerce.js'

const f = (amount, code) => money(amount, code)
const pseudoCtx = (client, party) => ({ client, party, user: { name: party.name } })
const act = (id, label, { otp = true, fields = [], tone } = {}) => ({ id, label, otp, fields, tone })
const phoneInput = (label = 'Votre numéro mobile money') => ({ name: 'phone', label, type: 'tel' })

/* Each kind: view(client, link, party) → { title, lines, status, actions }, and handlers keyed by action id. */
const KINDS = {
  recorded: {
    async view(c, link, party) {
      const r = await one(c, `SELECT r.*, pa.name AS payer_name, pb.name AS payee_name, rb.name AS by_name FROM recorded_payments r JOIN parties pa ON pa.id=r.payer_party
        JOIN parties pb ON pb.id=r.payee_party JOIN parties rb ON rb.id=r.recorded_by WHERE r.id=$1`, [link.ref_id])
      const incoming = r.payee_party === party.id
      return { title: r.purpose, lines: [[incoming ? 'De' : 'À', mask(incoming ? r.payer_name : r.payee_name)], ['Montant', f(r.amount, r.currency)], ['Signalé par', mask(r.by_name)]],
        status: { claimed: 'En attente de votre réponse', confirmed: 'Confirmé', rejected: 'Refusé' }[r.status],
        actions: r.status === 'claimed' && r.recorded_by !== party.id ? [act('confirm', incoming ? 'Je confirme avoir reçu' : 'Je confirme ce paiement', { tone: 'primary' }), act('reject', 'Ce n’est pas exact')] : [] }
    },
    confirm: (c, link, party) => settleRecorded(c, link.ref_id, party, true).then(() => 'Merci, paiement confirmé'),
    reject: (c, link, party) => settleRecorded(c, link.ref_id, party, false).then(() => 'Paiement refusé'),
  },

  escrow: {
    async view(c, link, party) {
      const e = await loadEscrow(c, link.ref_id), payee = await partyById(c, e.payee_party)
      const actions = []
      if (e.payer_party === party.id) {
        if (e.status === 'requested') actions.push(e.mode === 'held' ? act('pay', 'Payer et bloquer les fonds', { otp: false, fields: [phoneInput()], tone: 'primary' }) : act('claimPaid', 'J’ai payé', { tone: 'primary' }))
        if (e.status === 'held') actions.push(act('release', 'Libérer les fonds', { tone: 'primary' }), act('dispute', 'Signaler un problème', { fields: [{ name: 'reason', label: 'Que s’est-il passé ?', type: 'text' }] }))
      }
      return { title: e.title, lines: [['Pour', mask(payee.name)], ['Montant', f(e.amount, e.currency)], ['Protection', e.mode === 'held' ? 'L’argent reste bloqué et n’est versé qu’avec votre accord' : `Payez directement ${mask(payee.name)}, puis signalez-le ici`]],
        status: { requested: 'En attente de paiement', claimed: 'Paiement signalé', held: 'Fonds bloqués', released: 'Versé', paid: 'Payé', refunded: 'Remboursé', cancelled: 'Annulé', disputed: 'Litige en cours' }[e.status], actions }
    },
    async pay(c, link, party, input) { const r = await fundByCollection(c, await loadEscrow(c, link.ref_id), input.phone); return `Validez le paiement de ${f(r.amount, r.currency)} sur votre téléphone.` },
    async claimPaid(c, link, party) {
      const e = await loadEscrow(c, link.ref_id)
      if (e.payer_party !== party.id || e.mode !== 'recorded') fail('Action non autorisée', 403)
      await recordPayment(pseudoCtx(c, party), { payerParty: party, payeeParty: await partyById(c, e.payee_party), amount: e.amount, currency: e.currency, purpose: e.title, ref: `escrow:${e.id}` })
      await transition(c, 'escrows', e.id, 'requested', 'claimed')
      return 'Paiement signalé. Le bénéficiaire doit confirmer.'
    },
    async release(c, link, party) { const e = await loadEscrow(c, link.ref_id); if (e.payer_party !== party.id) fail('Action non autorisée', 403); await releaseEscrow(c, e); return 'Fonds versés' },
    async dispute(c, link, party, input) { const e = await loadEscrow(c, link.ref_id); if (e.payer_party !== party.id) fail('Action non autorisée', 403); await openDispute(c, e, party, String(input.reason ?? '').slice(0, 300) || 'Sans précision'); return 'Litige ouvert. Les fonds restent bloqués.' },
  },

  job: {
    async view(c, link, party) {
      const job = await one(c, 'SELECT * FROM jobs WHERE id=$1', [link.ref_id])
      const role = job.artisan_party === party.id ? 'artisan' : job.client_party === party.id ? 'client' : null
      const other = await partyById(c, role === 'artisan' ? job.client_party : job.artisan_party)
      const stages = await stagesOf(c, job.id), cur = stages.find(s => s.status !== 'paid')
      const actions = []
      if (cur && role === 'artisan') {
        if (job.mode === 'held' && cur.status === 'planned') actions.push(act('request', 'Demander le financement de l’étape', { tone: 'primary' }))
        if ((job.mode === 'held' && cur.status === 'funded') || (job.mode === 'recorded' && cur.status === 'planned')) actions.push(act('markDone', 'Étape terminée (avec photo)', { tone: 'primary', fields: [{ name: 'proof', label: 'Photo du chantier', type: 'upload', required: false }] }))
        if (job.mode === 'recorded' && ['validated', 'claimed'].includes(cur.status)) actions.push(act('markReceived', 'J’ai reçu le paiement', { tone: 'primary' }))
      }
      if (cur && role === 'client') {
        if (job.mode === 'held' && cur.status === 'requested') actions.push(act('fund', 'Payer et bloquer cette étape', { otp: false, tone: 'primary', fields: [phoneInput()] }))
        if (cur.status === 'done') actions.push(act('validate', job.mode === 'held' ? 'Valider et verser le paiement' : 'Valider l’étape', { tone: 'primary' }))
        if (job.mode === 'recorded' && cur.status === 'validated') actions.push(act('claimPaid', 'J’ai payé l’artisan', { tone: 'primary' }))
        if (job.mode === 'held' && ['funded', 'done'].includes(cur.status)) actions.push(act('dispute', 'Signaler un problème', { fields: [{ name: 'reason', label: 'Que s’est-il passé ?', type: 'text' }] }))
      }
      const label = { planned: 'à venir', requested: 'financement demandé', funded: 'financée', done: 'terminée, à valider', validated: 'validée, à payer', claimed: 'paiement signalé', paid: 'payée', disputed: 'litige' }
      return { title: job.title, lines: [[role === 'artisan' ? 'Client' : 'Artisan', mask(other.name)], ...stages.map(s => [`Étape ${s.position} · ${s.title}`, `${f(s.amount, job.currency)} · ${label[s.status]}${s.proof.length ? ` · ${s.proof.length} photo(s)` : ''}`])],
        status: cur ? `Étape ${cur.position} en cours` : 'Chantier terminé', actions, proof: cur?.proof ?? [] }
    },
    request: async (c, link, party) => { await jobOps.requestFunding(c, link.ref_id, party); return 'Demande envoyée. Le client reçoit un lien pour payer l’étape.' },
    markDone: async (c, link, party, input) => { await jobOps.markDone(c, link.ref_id, party, input.proof || null); return 'Étape signalée terminée. Le client est prévenu.' },
    async markReceived(c, link, party) {
      const stage = (await stagesOf(c, link.ref_id)).find(s => ['validated', 'claimed'].includes(s.status))
      if (!stage) fail('Cette action n’est plus possible', 409)
      const pending = await one(c, `SELECT id FROM recorded_payments WHERE ref=$1 AND status='claimed'`, [`escrow:${stage.escrow_id}`])
      if (pending) await settleRecorded(c, pending.id, party, true)
      else {
        const e = await loadEscrow(c, stage.escrow_id)
        if (e.payee_party !== party.id) fail('Action non autorisée', 403)
        await c.query(`INSERT INTO recorded_payments (id, payer_party, payee_party, amount, currency, purpose, ref, recorded_by, status, confirmed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$3,'confirmed', now())`, [newId(), e.payer_party, e.payee_party, e.amount, e.currency, e.title, `escrow:${e.id}`])
        await transition(c, 'escrows', e.id, ['requested', 'claimed'], 'paid')
        await c.query(`UPDATE job_stages SET status='paid' WHERE id=$1`, [stage.id])
      }
      return 'Réception confirmée'
    },
    async fund(c, link, party, input) {
      const stage = (await stagesOf(c, link.ref_id)).find(s => s.status === 'requested')
      if (!stage) fail('Cette action n’est plus possible', 409)
      const r = await fundByCollection(c, await loadEscrow(c, stage.escrow_id), input.phone)
      return `Validez le paiement de ${f(r.amount, r.currency)} sur votre téléphone.`
    },
    async validate(c, link, party) {
      const job = await one(c, 'SELECT * FROM jobs WHERE id=$1', [link.ref_id])
      if (job.client_party !== party.id) fail('Action non autorisée', 403)
      if (job.mode === 'recorded') { await jobOps.validateRecorded(c, job.id, party); return 'Étape validée. Payez l’artisan puis signalez-le.' }
      const stage = (await stagesOf(c, job.id)).find(s => s.status === 'done')
      if (!stage) fail('Cette action n’est plus possible', 409)
      await releaseEscrow(c, await loadEscrow(c, stage.escrow_id), 'Étape validée')
      return 'Étape validée, paiement versé'
    },
    async claimPaid(c, link, party) {
      const job = await one(c, 'SELECT * FROM jobs WHERE id=$1', [link.ref_id])
      const stage = (await stagesOf(c, job.id)).find(s => s.status === 'validated')
      if (job.client_party !== party.id || !stage) fail('Action non autorisée', 403)
      const e = await loadEscrow(c, stage.escrow_id)
      await recordPayment(pseudoCtx(c, party), { payerParty: party, payeeParty: await partyById(c, e.payee_party), amount: e.amount, currency: e.currency, purpose: e.title, ref: `escrow:${e.id}` })
      await transition(c, 'escrows', e.id, 'requested', 'claimed')
      await transition(c, 'job_stages', stage.id, 'validated', 'claimed')
      return 'Paiement signalé. L’artisan doit confirmer.'
    },
    async dispute(c, link, party, input) {
      const job = await one(c, 'SELECT * FROM jobs WHERE id=$1', [link.ref_id])
      const stage = (await stagesOf(c, job.id)).find(s => ['funded', 'done'].includes(s.status))
      if (!stage || ![job.client_party, job.artisan_party].includes(party.id)) fail('Action non autorisée', 403)
      await openDispute(c, await loadEscrow(c, stage.escrow_id), party, String(input.reason ?? '').slice(0, 300) || 'Sans précision')
      return 'Litige ouvert. Les fonds restent bloqués.'
    },
  },

  order: {
    async view(c, link, party) {
      const o = await one(c, 'SELECT o.*, u.name AS seller_name, u.phone AS seller_phone FROM orders o JOIN users u ON u.id=o.seller_id WHERE o.id=$1', [link.ref_id])
      const isBuyer = party && o.buyer_party === party.id
      const actions = []
      if (o.status === 'pending') actions.push(o.mode === 'held' ? act('pay', 'Payer par mobile money', { otp: false, tone: 'primary', fields: [phoneInput()] }) : act('claimPaid', 'J’ai payé', { otp: false, tone: 'primary', fields: [phoneInput('Le numéro qui a payé')] }))
      if (o.status === 'delivered' && isBuyer) actions.push(act('confirmReceived', 'J’ai bien reçu ma commande', { tone: 'primary' }))
      if (['paid', 'delivered'].includes(o.status) && isBuyer && o.mode === 'held') actions.push(act('dispute', 'Signaler un problème', { fields: [{ name: 'reason', label: 'Que s’est-il passé ?', type: 'text' }] }))
      return { title: o.item, lines: [['Vendeuse', mask(o.seller_name)], ['Prix', f(o.amount, o.currency)],
        o.mode === 'held' ? ['Protection', 'Votre argent est versé à la vendeuse seulement quand vous confirmez la réception'] : ['Comment payer', `Payez directement au ${o.seller_phone} (Wave, Orange Money…), puis appuyez sur « J’ai payé »`]],
        status: { pending: 'À payer', claimed: 'Paiement signalé', paid: 'Payé', delivered: 'Livré, à confirmer', completed: 'Terminé', disputed: 'Litige en cours', refunded: 'Remboursé', cancelled: 'Annulé' }[o.status], actions }
    },
    pay: async (c, link, party, input) => { await orderOps.payByCollection(c, link.ref_id, input.phone); return 'Validez le paiement sur votre téléphone.' },
    claimPaid: async (c, link, party, input) => { await orderOps.claimPaid(c, link.ref_id, input.phone); return 'Paiement signalé. La vendeuse doit confirmer.' },
    confirmReceived: async (c, link, party) => { await orderOps.confirmReceived(c, link.ref_id, party); return 'Merci ! Le paiement est versé à la vendeuse.' },
    dispute: async (c, link, party, input) => { await orderOps.dispute(c, link.ref_id, party, String(input.reason ?? '').slice(0, 300) || 'Sans précision'); return 'Litige ouvert. L’argent reste bloqué.' },
  },

  tontine: {
    async view(c, link, party) {
      const t = await one(c, 'SELECT * FROM tontines WHERE id=$1', [link.ref_id])
      const members = await membersOf(c, t), me = members.find(m => m.party_id === party.id)
      const actions = []
      if (t.status === 'forming' && !me.accepted_at) actions.push(act('accept', 'Rejoindre le groupe', { tone: 'primary' }))
      const paid = t.status === 'active' && await one(c, 'SELECT 1 FROM tontine_contribs WHERE tontine_id=$1 AND round=$2 AND party_id=$3', [t.id, t.round, party.id])
      if (t.status === 'active' && !paid) actions.push(t.mode === 'held' ? act('pay', 'Cotiser par mobile money', { otp: false, tone: 'primary', fields: [phoneInput()] }) : act('claim', 'J’ai payé l’organisateur', { tone: 'primary' }))
      return { title: t.name, lines: [['Cotisation', `${f(t.amount, t.currency)} ${t.frequency === 'weekly' ? 'chaque semaine' : 'chaque mois'}`], ['Membres', `${members.length} (${members.filter(m => m.accepted_at).length} ont accepté)`],
        ...(t.status === 'active' ? [['Tour', `${t.round} sur ${t.size}, avant le ${longDate(t.next_due)}`], ['Votre tour', `n° ${me.position}`]] : [['Ordre des tours', 'Tiré au sort quand tout le monde a accepté']])],
        status: { forming: 'En attente des membres', active: 'Actif', completed: 'Terminé' }[t.status], actions }
    },
    accept: async (c, link, party) => { await tontineOps.acceptInvite(c, link.ref_id, party); return 'Vous avez rejoint le groupe' },
    pay: async (c, link, party, input) => { await tontineOps.payByCollection(c, link.ref_id, party, input.phone); return 'Validez le paiement sur votre téléphone.' },
    async claim(c, link, party) {
      const t = await one(c, 'SELECT * FROM tontines WHERE id=$1', [link.ref_id])
      if (t.mode !== 'recorded' || t.status !== 'active') fail('Cette action n’est plus possible', 409)
      const organiser = await one(c, 'SELECT * FROM parties WHERE user_id=$1', [t.organiser_id])
      await c.query(`INSERT INTO tontine_contribs (tontine_id, round, party_id, status) VALUES ($1,$2,$3,'claimed')`, [t.id, t.round, party.id])
      await recordPayment(pseudoCtx(c, party), { payerParty: party, payeeParty: organiser, amount: t.amount, currency: t.currency, purpose: `Cotisation ${t.name}, tour ${t.round}`, ref: `tontine:${t.id}@${t.round}` })
      return 'Cotisation signalée. L’organisateur doit confirmer.'
    },
  },

  statement: {
    async view(c, link, party) {
      const cust = await one(c, 'SELECT c.*, u.name AS shop_name FROM customers c JOIN users u ON u.id=c.shop_id WHERE c.id=$1', [link.ref_id])
      const cur = (await one(c, 'SELECT region FROM users WHERE id=$1', [cust.shop_id])).region
      const owed = await owedBy(c, cust.id)
      const entries = await all(c, 'SELECT * FROM credit_entries WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 10', [cust.id])
      const code = REGIONS[cur].currency.code
      return { title: `Votre carnet chez ${mask(cust.shop_name)}`, lines: [['Reste à payer', f(owed, code)], ...entries.map(e => [new Date(e.created_at).toLocaleDateString('fr-FR'), `${e.amount > 0 ? 'Crédit' : 'Remboursement'} ${f(Math.abs(e.amount), code)}`])],
        status: owed > 0 ? 'À rembourser' : 'À jour', actions: owed > 0 ? [act('claimPaid', 'J’ai remboursé', { tone: 'primary', fields: [{ name: 'amount', label: 'Montant remboursé', type: 'amount' }] })] : [] }
    },
    async claimPaid(c, link, party, input) {
      const cust = await one(c, 'SELECT * FROM customers WHERE id=$1', [link.ref_id])
      const shop = await one(c, 'SELECT p.*, u.region FROM parties p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1', [cust.shop_id])
      const cur = REGIONS[shop.region].currency
      const { toMinor } = await import('./core.js')
      const amount = toMinor(input.amount, cur)
      if (amount > await owedBy(c, cust.id)) fail('Montant supérieur à ce qui reste dû')
      await recordPayment(pseudoCtx(c, party), { payerParty: party, payeeParty: shop, amount, currency: cur.code, purpose: 'Remboursement carnet', ref: `credit:${cust.id}` })
      return 'Remboursement signalé. La boutique doit confirmer.'
    },
  },
}

export const publicRoutes = Router()

publicRoutes.get('/:token', async (req, res) => {
  const link = await resolveLink(pool, req.params.token)
  const party = link.party_id ? await partyById(pool, link.party_id) : null
  const view = await KINDS[link.kind].view(pool, link, party)
  res.json({ kind: link.kind, ...view, phone: party ? `${party.phone.slice(0, 4)} •••• ${party.phone.slice(-2)}` : null })
})

publicRoutes.post('/:token/otp', async (req, res) => {
  const link = await resolveLink(pool, req.params.token)
  if (!link.party_id) fail('Ce lien n’est lié à aucun numéro', 400)
  const party = await partyById(pool, link.party_id)
  const code = await issueOtp(party.phone, req.ip)
  res.json({ ok: true, ...(code ? { sandboxCode: code } : {}) })
})

publicRoutes.post('/:token/act', async (req, res) => {
  const link = await resolveLink(pool, req.params.token)
  const kind = KINDS[link.kind]
  const party = link.party_id ? await partyById(pool, link.party_id) : null
  const view = await kind.view(pool, link, party)
  const action = view.actions.find(a => a.id === req.body?.action)
  if (!action || !Object.hasOwn(kind, action.id)) fail('Action indisponible', 404)
  if (action.otp) {
    if (!party) fail('Ce lien n’est lié à aucun numéro', 400)
    await consumeOtp(party.phone, req.body?.code, req.ip)
  }
  const input = { ...(req.body?.input ?? {}) }
  if (input.phone !== undefined) input.phone = normalizePhone(input.phone, party ? REGIONS[regionOfPhone(party.phone)]?.dialCode : '')
  const message = await tx(async c => {
    const msg = await kind[action.id](c, link, party, input)
    await audit(c, { actorType: 'party', actorId: party?.id ?? null, action: `link.${link.kind}.${action.id}`, objectType: link.kind, objectId: link.ref_id, ip: req.ip })
    return msg
  })
  res.json({ message })
})

export { CURRENCIES as _cur, notify as _notify }
