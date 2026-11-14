import { one, all, transition } from '../db.js'
import { config } from '../config.js'
import { fail, newId, today, ago, money, mask, longDate } from '../core.js'
import { rowsBlock, partyById, partyByPhone } from '../context.js'
import { notify, createLink, shareFor, startPayout, startCollection, collectionHandlers, payoutHandlers } from '../rails.js'
import { amountField, phoneField, textField, code10, regionOfPhone, recordPayment, settleRecorded, onRecordedConfirmed, onRecordedRejected, returnCollection } from './shared.js'
import { createRequest, fundPlan, loadEscrow, releaseEscrow, refundEscrow, openDispute, escrowHooks } from './escrow.js'

const owned = table => async (ctx, id, status) => {
  const r = await one(ctx.client, `SELECT * FROM ${table} WHERE id=$1 AND ${table === 'orders' ? 'seller_id' : 'user_id'}=$2`, [id, ctx.user.id])
  if (!r) fail('Introuvable', 404)
  if (status && ![status].flat().includes(r.status)) fail('Cette action n’est plus possible', 409)
  return r
}
const simple = (label, effect, message) => ({ label, form: () => ({ title: label, fields: [] }), async run(ctx, input, rowId) { return { message, ...(await effect(ctx, rowId) ?? {}) } } })

/* ---------------- orders: protected payment requests ---------------- */
const order = owned('orders')
export const orderByCode = async (client, code) => {
  const o = await one(client, `SELECT * FROM orders WHERE code=$1`, [String(code).trim().toUpperCase()])
  if (!o || o.status !== 'pending') fail('Code inconnu ou déjà payé', 404)
  return o
}

escrowHooks.order.funded = (c, e) => c.query(`UPDATE orders SET status='paid', paid_at=now(), paid_via='nexus', escrow_id=$2 WHERE id=$1 AND status='pending'`, [e.order_id, e.id])
escrowHooks.order.released = (c, e) => c.query(`UPDATE orders SET status='completed' WHERE id=$1`, [e.order_id])
escrowHooks.order.refunded = (c, e) => c.query(`UPDATE orders SET status='refunded' WHERE id=$1`, [e.order_id])
escrowHooks.order.disputed = (c, e) => c.query(`UPDATE orders SET status='disputed' WHERE id=$1`, [e.order_id])
onRecordedRejected.order = (c, id) => c.query(`UPDATE orders SET status='pending' WHERE id=$1 AND status='claimed'`, [id])
onRecordedConfirmed.order = async (c, id) => { await c.query(`UPDATE orders SET status='paid', paid_at=now(), paid_via='direct' WHERE id=$1 AND status IN ('pending','claimed')`, [id]) }

// Buyer with an account pays from their wallet; the money is held until they confirm delivery.
export async function payOrderPlan(ctx, o) {
  if (o.mode !== 'held') fail('Cette vendeuse se fait payer en direct : utilisez le lien qu’elle vous a envoyé')
  if (o.currency !== ctx.cur.code) fail('Ce code n’est payable que dans le pays de la vendeuse')
  const seller = await one(ctx.client, 'SELECT * FROM parties WHERE user_id=$1', [o.seller_id])
  if (seller.id === ctx.party.id) fail('Ce code est le vôtre')
  return {
    review: { lines: [['Vendeuse', mask(seller.name)], ['Article', o.item], ['Protection', 'Versé à la vendeuse quand vous confirmez la réception'], ['Total débité', ctx.f(o.amount), true]], cta: `Payer ${ctx.f(o.amount)}` },
    async exec() {
      await ctx.client.query('UPDATE orders SET buyer_party=$2 WHERE id=$1', [o.id, ctx.party.id])
      const { id } = await createRequest(ctx.client, { payee: seller, payer: ctx.party, amount: o.amount, currency: o.currency, title: o.item, mode: 'held', orderId: o.id, notifyPayer: false })
      await (await fundPlan(ctx, await loadEscrow(ctx.client, id))).exec()
      await notify(ctx.client, { partyId: seller.id, template: 'order.paid', text: `Commande payée : ${o.item} (${ctx.f(o.amount)}). Livrez, puis marquez-la livrée.` })
      return { message: `${ctx.f(o.amount)} payés. Ils sont versés à ${mask(seller.name)} quand vous confirmez la réception.` }
    },
  }
}

collectionHandlers.order = async (client, op) => {
  const o = await one(client, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [op.purpose.orderId])
  if (o.status !== 'pending') return returnCollection(client, op, o.item)
  const seller = await one(client, 'SELECT * FROM parties WHERE user_id=$1', [o.seller_id])
  const buyer = await partyByPhone(client, op.phone, o.customer_name)
  await client.query('UPDATE orders SET buyer_party=$2 WHERE id=$1', [o.id, buyer.id])
  const { id } = await createRequest(client, { payee: seller, payer: buyer, amount: o.amount, currency: o.currency, title: o.item, mode: 'held', orderId: o.id, notifyPayer: false })
  const { post, sys } = await import('../ledger.js')
  await post(client, { kind: 'escrow_hold', idem: `order:${op.id}`, lines: [{ account: await sys(client, 'rail', op.currency), amount: -op.amount }, { account: await sys(client, 'escrow', o.currency), amount: o.amount }] })
  await transition(client, 'escrows', id, 'requested', 'held', { paid_currency: op.currency, paid_amount: op.amount })
  await escrowHooks.order.funded(client, { order_id: o.id, id })
  await notify(client, { partyId: seller.id, template: 'order.paid', text: `Commande payée par mobile money : ${o.item} (${money(o.amount, o.currency)}). Livrez, puis marquez-la livrée.` })
}

// Party-level operations used by the public link page.
export const orderOps = {
  async payByCollection(client, orderId, phone) {
    const o = await one(client, 'SELECT * FROM orders WHERE id=$1', [orderId])
    if (o.status !== 'pending' || o.mode !== 'held') fail('Cette commande ne peut plus être payée ici', 409)
    if (regionOfPhone(phone) !== (await one(client, 'SELECT region FROM users WHERE id=$1', [o.seller_id])).region) fail('Le paiement doit venir d’un numéro du même pays que la vendeuse')
    return startCollection(client, { amount: o.amount, currency: o.currency, phone, purpose: { type: 'order', orderId: o.id } })
  },
  async claimPaid(client, orderId, buyerPhone) {
    const o = await one(client, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])
    if (o.status !== 'pending' || o.mode !== 'recorded') fail('Cette commande ne peut plus être signalée payée', 409)
    const seller = await one(client, 'SELECT p.*, u.name AS uname FROM parties p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1', [o.seller_id])
    const buyer = await partyByPhone(client, buyerPhone, o.customer_name)
    await client.query(`UPDATE orders SET status='claimed', buyer_party=$2 WHERE id=$1`, [o.id, buyer.id])
    await client.query(`INSERT INTO recorded_payments (id, payer_party, payee_party, amount, currency, purpose, ref, recorded_by, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$2,'claimed')`,
      [newId(), buyer.id, seller.id, o.amount, o.currency, o.item, `order:${o.id}`])
    await notify(client, { partyId: seller.id, template: 'order.claimed', text: `${mask(buyer.name)} dit avoir payé ${money(o.amount, o.currency)} pour « ${o.item} ». Vérifiez et confirmez.` })
  },
  async confirmReceived(client, orderId, buyerParty) {
    const o = await one(client, 'SELECT * FROM orders WHERE id=$1', [orderId])
    if (!o || o.buyer_party !== buyerParty.id) fail('Action non autorisée', 403)
    if (o.status !== 'delivered') fail('La commande n’est pas encore marquée livrée', 409)
    if (o.mode === 'held') await releaseEscrow(client, await loadEscrow(client, o.escrow_id), 'Commande reçue')
    else await client.query(`UPDATE orders SET status='completed' WHERE id=$1`, [o.id])
  },
  async dispute(client, orderId, buyerParty, reason) {
    const o = await one(client, 'SELECT * FROM orders WHERE id=$1', [orderId])
    if (!o || o.buyer_party !== buyerParty.id || o.mode !== 'held') fail('Action non autorisée', 403)
    await openDispute(client, await loadEscrow(client, o.escrow_id), buyerParty, reason)
  },
}

const orderRow = (ctx, o) => {
  const held = o.mode === 'held'
  const map = {
    pending: ['En attente', 'wait', [{ id: 'share', label: 'Envoyer le lien', tone: 'primary' }, ...(held ? [] : [{ id: 'markPaid', label: 'Payé' }]), { id: 'cancel', label: 'Annuler' }]],
    claimed: ['Paiement signalé', 'wait', [{ id: 'confirmPaid', label: 'Confirmer le paiement', tone: 'primary' }]],
    paid: [held ? 'Payé, protégé' : 'Payé', 'ok', [{ id: 'deliver', label: 'Marquer livré', tone: 'primary' }, ...(held ? [{ id: 'refund', label: 'Rembourser' }] : [])]],
    delivered: [held ? 'Livré, en attente de confirmation' : 'Livré', 'ok', held ? [] : [{ id: 'complete', label: 'Terminer' }]],
    completed: ['Terminé', 'ok', []], disputed: ['Litige', 'bad', []], refunded: ['Remboursé', '', []], cancelled: ['Annulé', '', []],
  }
  const [status, tone, actions] = map[o.status]
  return { id: o.id, title: o.item, sub: `${o.customer_name} · ${o.status === 'pending' ? `code ${o.code}` : ago(o.created_at).toLowerCase()}`, value: ctx.f(o.amount), status, tone, actions }
}
const ordersBy = (ctx, statuses) => all(ctx.client, `SELECT * FROM orders WHERE seller_id=$1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 20`, [ctx.user.id, statuses])

export const orders = {
  async view(ctx) {
    return { blocks: [
      await orders.widgets.kpis(ctx),
      rowsBlock('À encaisser', 'package', (await ordersBy(ctx, ['pending', 'claimed'])).map(o => orderRow(ctx, o)), 'Créez une demande de paiement et envoyez le lien à votre cliente.'),
      rowsBlock('À livrer', 'package', (await ordersBy(ctx, ['paid', 'delivered', 'disputed'])).map(o => orderRow(ctx, o))),
      rowsBlock('Terminées', 'package', (await ordersBy(ctx, ['completed', 'cancelled', 'refunded'])).map(o => orderRow(ctx, o)))],
      actions: ['create'] }
  },
  widgets: {
    rows: async ctx => rowsBlock(null, 'package', (await ordersBy(ctx, ['pending', 'claimed', 'paid'])).slice(0, 3).map(o => orderRow(ctx, o))),
    async kpis(ctx) {
      const k = await one(ctx.client, `SELECT COALESCE(SUM(amount) FILTER (WHERE paid_at::date = CURRENT_DATE),0)::bigint AS sales, count(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS n,
        COALESCE(SUM(amount) FILTER (WHERE status IN ('pending','claimed')),0)::bigint AS due FROM orders WHERE seller_id=$1`, [ctx.user.id])
      return { type: 'kpis', title: "Aujourd'hui", items: [{ label: 'Ventes', value: ctx.f(k.sales) }, { label: 'Commandes', value: String(k.n) }, { label: 'À encaisser', value: ctx.f(k.due), tone: k.due ? 'wait' : '' }] }
    },
  },
  actions: {
    create: {
      label: 'Demande de paiement', icon: 'link',
      form: ctx => ({ title: 'Nouvelle demande de paiement', info: ctx.held ? 'Votre cliente paie depuis son mobile money, sans application. L’argent est protégé et vous est versé à la livraison confirmée (ou automatiquement après 72 h).' : 'Votre cliente vous paie directement et le signale sur le lien ; vous confirmez la réception.',
        fields: [textField('item', 'Article'), amountField('Prix'), textField('customer', 'Nom de la cliente'), phoneField('Numéro de la cliente (facultatif)', { required: false })] }),
      async run(ctx, input) {
        let code
        do { code = code10() } while (await one(ctx.client, 'SELECT 1 FROM orders WHERE code=$1', [code]))
        const buyer = input.phone ? await ctx.findParty(input.phone, input.customer) : null
        const id = newId()
        await ctx.client.query('INSERT INTO orders (id, seller_id, item, amount, currency, buyer_party, customer_name, code, mode, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,\'pending\')',
          [id, ctx.user.id, input.item, input.amount, ctx.cur.code, buyer?.id ?? null, input.customer, code, ctx.held ? 'held' : 'recorded'])
        const url = await createLink(ctx.client, { kind: 'order', refId: id, partyId: buyer?.id ?? null })
        const text = `${mask(ctx.user.name)} vous demande ${ctx.f(input.amount)} pour « ${input.item} ». Payez ici${ctx.held ? ', votre argent est protégé jusqu’à la livraison' : ''} :`
        if (buyer) await notify(ctx.client, { partyId: buyer.id, template: 'order.request', text, link: url })
        return { message: `Demande créée (code ${code}). Envoyez le lien à ${input.customer}.`, share: shareFor(text, url), copy: code }
      },
    },
    share: simple('Envoyer le lien', async (ctx, id) => {
      const o = await order(ctx, id, ['pending'])
      const url = await createLink(ctx.client, { kind: 'order', refId: o.id, partyId: o.buyer_party })
      return { share: shareFor(`${mask(ctx.user.name)} vous demande ${ctx.f(o.amount)} pour « ${o.item} » :`, url) }
    }, 'Lien prêt à partager'),
    markPaid: simple('Payé en direct', async (ctx, id) => {
      const o = await order(ctx, id, ['pending'])
      if (o.mode !== 'recorded') fail('Ce paiement passe par le partenaire')
      await transition(ctx.client, 'orders', o.id, 'pending', 'paid', { paid_at: new Date(), paid_via: 'direct' })
    }, 'Commande marquée payée'),
    confirmPaid: simple('Confirmer le paiement', async (ctx, id) => {
      const o = await order(ctx, id, ['claimed'])
      const rp = await one(ctx.client, `SELECT id FROM recorded_payments WHERE ref=$1 AND status='claimed'`, [`order:${o.id}`])
      await settleRecorded(ctx.client, rp.id, ctx.party, true)
    }, 'Paiement confirmé'),
    deliver: simple('Marquer livré', async (ctx, id) => {
      const o = await order(ctx, id, ['paid'])
      await transition(ctx.client, 'orders', o.id, 'paid', 'delivered')
      if (o.mode === 'held') await ctx.client.query(`UPDATE escrows SET auto_release_at = now() + make_interval(hours => $2) WHERE id=$1`, [o.escrow_id, config.orderReleaseHours])
      if (o.buyer_party) {
        const url = await createLink(ctx.client, { kind: 'order', refId: o.id, partyId: o.buyer_party })
        await notify(ctx.client, { partyId: o.buyer_party, template: 'order.delivered', text: `« ${o.item} » est marqué livré. Confirmez la réception${o.mode === 'held' ? ` (sinon le paiement part automatiquement dans ${config.orderReleaseHours} h)` : ''} :`, link: url })
      }
    }, 'Commande livrée. La cliente est invitée à confirmer.'),
    complete: simple('Terminer', async (ctx, id) => { const o = await order(ctx, id, ['delivered']); if (o.mode === 'held') fail('La cliente doit confirmer la réception'); await transition(ctx.client, 'orders', o.id, 'delivered', 'completed') }, 'Commande terminée'),
    refund: {
      label: 'Rembourser', form: () => ({ title: 'Rembourser la cliente', fields: [] }),
      async plan(ctx, input, id) {
        const o = await order(ctx, id, ['paid'])
        if (o.mode !== 'held') fail('Ce paiement s’est fait en direct : remboursez la cliente directement')
        const e = await loadEscrow(ctx.client, o.escrow_id)
        return {
          review: { lines: [['Cliente', o.customer_name], ['Article', o.item], ['Montant rendu', money(e.paid_amount, e.paid_currency), true]], cta: `Rembourser ${money(e.paid_amount, e.paid_currency)}` },
          async exec() { await transition(ctx.client, 'escrows', e.id, 'held', 'refunded'); await refundEscrow(ctx.client, e); await escrowHooks.order.refunded(ctx.client, e); return { message: 'Cliente remboursée' } },
        }
      },
    },
    cancel: simple('Annuler la commande', async (ctx, id) => { const o = await order(ctx, id, ['pending']); await transition(ctx.client, 'orders', o.id, 'pending', 'cancelled') }, 'Commande annulée'),
  },
}

/* ---------------- credit book: record-keeping, with reminders customers can answer ---------------- */
const debtors = ctx => all(ctx.client, `SELECT c.id, c.name, c.party_id, SUM(e.amount)::bigint AS owed, MIN(e.created_at) AS since
  FROM customers c JOIN credit_entries e ON e.customer_id=c.id WHERE c.shop_id=$1 GROUP BY c.id HAVING SUM(e.amount) > 0 ORDER BY since`, [ctx.user.id])
const debtorRow = (ctx, d) => ({ id: d.id, title: d.name, sub: `Depuis ${ago(d.since).toLowerCase()}`, value: ctx.f(d.owed),
  actions: [{ id: 'repay', label: 'Remboursement', tone: 'primary' }, ...(d.party_id ? [{ id: 'remind', label: 'Rappel WhatsApp' }] : [])] })
async function customerFor(ctx, id) {
  const c = await one(ctx.client, 'SELECT * FROM customers WHERE id=$1 AND shop_id=$2', [id, ctx.user.id])
  return c ?? fail('Client introuvable', 404)
}
export const owedBy = async (client, customerId) => (await one(client, 'SELECT COALESCE(SUM(amount),0)::bigint AS owed FROM credit_entries WHERE customer_id=$1', [customerId])).owed
onRecordedConfirmed.credit = async (c, customerId, rp) => {
  const cust = await one(c, 'SELECT * FROM customers WHERE id=$1', [customerId])
  await c.query('INSERT INTO credit_entries (id, shop_id, customer_id, amount, note) VALUES ($1,$2,$3,$4,$5)', [newId(), cust.shop_id, cust.id, -rp.amount, 'Remboursement confirmé'])
}

export const creditbook = {
  async view(ctx) {
    return { blocks: [await creditbook.widgets.kpis(ctx), rowsBlock('Crédits en cours', 'notebook-pen', (await debtors(ctx)).map(d => debtorRow(ctx, d)), 'Aucun crédit en cours.')], actions: ['add'] }
  },
  widgets: {
    rows: async ctx => rowsBlock(null, 'notebook-pen', (await debtors(ctx)).slice(0, 3).map(d => debtorRow(ctx, d))),
    async kpis(ctx) { const d = await debtors(ctx); return { type: 'kpis', title: 'Carnet de crédit', items: [{ label: 'Total dû', value: ctx.f(d.reduce((s, x) => s + x.owed, 0)), tone: d.length ? 'wait' : '' }, { label: 'Clients', value: String(d.length) }] } },
  },
  actions: {
    add: {
      label: 'Noter un crédit', icon: 'notebook-pen',
      async form(ctx) {
        const known = await all(ctx.client, 'SELECT id, name FROM customers WHERE shop_id=$1 ORDER BY name', [ctx.user.id])
        return { title: 'Noter un crédit', fields: [
          ...(known.length ? [{ name: 'customer', label: 'Client existant', type: 'select', required: false, options: known.map(k => ({ value: k.id, label: k.name })) }] : []),
          textField('name', known.length ? 'Ou nouveau client : nom' : 'Nom du client', { required: !known.length }),
          phoneField('Son numéro (pour les rappels WhatsApp)', { required: false }), amountField(), textField('note', 'Note (facultatif)', { required: false })] }
      },
      async run(ctx, input) {
        let cust
        if (input.customer) cust = await customerFor(ctx, input.customer)
        else {
          if (!input.name) fail('Choisissez un client ou indiquez un nom')
          const party = input.phone ? await ctx.findParty(input.phone, input.name) : null
          cust = { id: newId(), name: input.name }
          await ctx.client.query('INSERT INTO customers (id, shop_id, name, party_id) VALUES ($1,$2,$3,$4)', [cust.id, ctx.user.id, input.name, party?.id ?? null])
        }
        await ctx.client.query('INSERT INTO credit_entries (id, shop_id, customer_id, amount, note) VALUES ($1,$2,$3,$4,$5)', [newId(), ctx.user.id, cust.id, input.amount, input.note ?? null])
        return { message: `${ctx.f(input.amount)} notés pour ${cust.name}` }
      },
    },
    repay: {
      label: 'Remboursement', form: () => ({ title: 'Noter un remboursement', fields: [amountField('Montant remboursé')] }),
      async run(ctx, input, id) {
        const c = await customerFor(ctx, id), owed = await owedBy(ctx.client, c.id)
        if (input.amount > owed) fail(`${c.name} ne doit que ${ctx.f(owed)}`)
        await ctx.client.query('INSERT INTO credit_entries (id, shop_id, customer_id, amount, note) VALUES ($1,$2,$3,$4,$5)', [newId(), ctx.user.id, c.id, -input.amount, 'Remboursement'])
        return { message: `Remboursement de ${ctx.f(input.amount)} noté` }
      },
    },
    remind: {
      label: 'Rappel WhatsApp', form: () => ({ title: 'Envoyer un rappel', fields: [] }),
      async run(ctx, input, id) {
        const c = await customerFor(ctx, id)
        if (!c.party_id) fail('Ajoutez d’abord le numéro de ce client')
        const owed = await owedBy(ctx.client, c.id)
        const url = await createLink(ctx.client, { kind: 'statement', refId: c.id, partyId: c.party_id })
        const text = `Bonjour ${c.name}, petit rappel de ${mask(ctx.user.name)} : il reste ${ctx.f(owed)} sur votre carnet. Détail et paiement :`
        await notify(ctx.client, { partyId: c.party_id, template: 'credit.reminder', text, link: url, dedupe: `remind:${c.id}:${today()}` })
        return { message: 'Rappel prêt', share: shareFor(text, url) }
      },
    },
  },
}

/* ---------------- supplier invoices ---------------- */
const invoice = owned('invoices')
payoutHandlers.succeeded.invoice = (c, op) => c.query(`UPDATE invoices SET status='paid', paid_at=now() WHERE id=$1 AND status='paying'`, [op.purpose.invoiceId])
payoutHandlers.failed.invoice = (c, op) => c.query(`UPDATE invoices SET status='open' WHERE id=$1 AND status='paying'`, [op.purpose.invoiceId])
const invoiceRows = async (ctx, status) => (await all(ctx.client, 'SELECT * FROM invoices WHERE user_id=$1 AND status=$2 ORDER BY COALESCE(due_date, created_at::date) LIMIT 20', [ctx.user.id, status])).map(i => ({
  id: i.id, title: i.supplier, value: ctx.f(i.amount),
  sub: status === 'paid' ? `Payée ${ago(i.paid_at).toLowerCase()}` : i.due_date ? `Échéance le ${longDate(i.due_date)}` : 'Sans échéance',
  ...(status === 'paying' ? { status: 'En cours', tone: 'wait' } : status === 'open' ? { status: i.due_date && i.due_date < today() ? 'En retard' : 'À payer', tone: i.due_date && i.due_date < today() ? 'bad' : 'wait', actions: [ctx.held ? { id: 'pay', label: 'Payer', tone: 'primary' } : { id: 'markPaid', label: 'Marquer payée', tone: 'primary' }] } : { status: 'Payée', tone: 'ok' }),
}))

export const invoices = {
  async view(ctx) {
    return { blocks: [await invoices.widgets.kpis(ctx), rowsBlock('À régler', 'receipt-text', await invoiceRows(ctx, 'open'), 'Aucune facture à régler.'), rowsBlock('Paiement en cours', 'receipt-text', await invoiceRows(ctx, 'paying')), rowsBlock('Payées', 'receipt-text', await invoiceRows(ctx, 'paid'))], actions: ['create'] }
  },
  widgets: {
    rows: async ctx => rowsBlock(null, 'receipt-text', (await invoiceRows(ctx, 'open')).slice(0, 3)),
    async kpis(ctx) {
      const k = await one(ctx.client, `SELECT COALESCE(SUM(amount),0)::bigint AS due, count(*)::int AS n, count(*) FILTER (WHERE due_date < CURRENT_DATE)::int AS late FROM invoices WHERE user_id=$1 AND status='open'`, [ctx.user.id])
      return { type: 'kpis', title: 'Factures', items: [{ label: 'À régler', value: ctx.f(k.due) }, { label: 'Ouvertes', value: String(k.n) }, { label: 'En retard', value: String(k.late), tone: k.late ? 'bad' : '' }] }
    },
  },
  actions: {
    create: {
      label: 'Facture fournisseur', icon: 'plus',
      form: () => ({ title: 'Nouvelle facture fournisseur', fields: [textField('supplier', 'Fournisseur'), amountField(), { name: 'due', label: 'Échéance (facultatif)', type: 'date', required: false }] }),
      async run(ctx, input) {
        await ctx.client.query('INSERT INTO invoices (id, user_id, supplier, amount, due_date) VALUES ($1,$2,$3,$4,$5)', [newId(), ctx.user.id, input.supplier, input.amount, input.due ?? null])
        return { message: `Facture ${input.supplier} enregistrée` }
      },
    },
    pay: {
      label: 'Payer', custody: 'held',
      form: () => ({ title: 'Payer la facture', info: config.sandbox ? 'Bac à sable : le virement fournisseur est simulé par le partenaire.' : undefined, fields: [phoneField('Numéro mobile money du fournisseur')] }),
      async plan(ctx, input, id) {
        const i = await invoice(ctx, id, 'open')
        return {
          review: { lines: [['Fournisseur', i.supplier], ['Vers', input.phone], ['Total débité', ctx.f(i.amount), true]], cta: `Payer ${ctx.f(i.amount)}` },
          async exec() {
            await startPayout(ctx.client, { source: await ctx.wallet(), amount: i.amount, phone: input.phone, userId: ctx.user.id, title: `Facture ${i.supplier}`, purpose: { type: 'invoice', invoiceId: i.id } })
            await transition(ctx.client, 'invoices', i.id, 'open', 'paying')
            return { message: `Facture ${i.supplier} en cours de paiement` }
          },
        }
      },
    },
    markPaid: simple('Marquer payée', async (ctx, id) => { const i = await invoice(ctx, id, 'open'); await transition(ctx.client, 'invoices', i.id, 'open', 'paid', { paid_at: new Date() }) }, 'Facture marquée payée'),
  },
}

export { partyById as _partyById }
