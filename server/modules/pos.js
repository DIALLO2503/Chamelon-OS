// "Encaisser": take a payment from a customer standing in front of you, without a card terminal.
// held custody: Nexus asks the payment partner to send a payment request to the customer's mobile money; the customer approves
// it on their own phone and the merchant's wallet is credited when the partner confirms (signed webhook).
// record custody: no money passes through Nexus; the customer scans a code (or opens the link) and confirms the payment,
// which then counts as a confirmed payment like any other.
import { one, all } from '../db.js'
import { config } from '../config.js'
import { post, sys } from '../ledger.js'
import { newId, ago, mask, normalizePhone, fail } from '../core.js'
import { walletOf, rowsBlock, userById } from '../context.js'
import { startCollection, collectionHandlers, collectionFailedHandlers, notify } from '../rails.js'
import { amountField, phoneField, textField, recordPayment, onRecordedConfirmed, onRecordedRejected, returnCollection } from './shared.js'

const STATUS = { pending: ['En attente', 'wait'], paid: ['Payé', 'ok'], failed: ['Échoué', 'bad'], rejected: ['Refusé', 'bad'] }

const salesToday = ctx => one(ctx.client, `SELECT count(*) FILTER (WHERE status='paid')::int AS n, COALESCE(SUM(amount) FILTER (WHERE status='paid'),0)::bigint AS total,
  count(*) FILTER (WHERE status='pending')::int AS waiting FROM pos_sales WHERE user_id=$1 AND created_at::date = CURRENT_DATE`, [ctx.user.id])

async function markPaid(client, saleId) {
  const sale = await one(client, `UPDATE pos_sales SET status='paid', paid_at=now() WHERE id=$1 AND status='pending' RETURNING *`, [saleId])
  if (sale) await notify(client, { userId: sale.user_id, template: 'pos.paid', text: `Encaissé : ${sale.label}.`, dedupe: `pos-paid:${sale.id}` })
  return sale
}

// The partner confirmed the customer's payment: credit the merchant. A payment for a sale that is no longer pending goes back.
collectionHandlers.pos = async (client, op) => {
  const sale = await one(client, 'SELECT * FROM pos_sales WHERE id=$1 FOR UPDATE', [op.purpose.saleId])
  if (!sale || sale.status !== 'pending') return returnCollection(client, op, sale?.label ?? 'Encaissement')
  const merchant = await userById(client, sale.user_id)
  const payer = await one(client, 'SELECT id FROM parties WHERE phone=$1', [op.phone])
  await post(client, { kind: 'pos_sale', idem: `pos:${op.id}`, lines: [
    { account: await sys(client, 'rail', op.currency), amount: -op.amount },
    { account: await walletOf(client, merchant), amount: op.amount, title: sale.label, cpParty: payer?.id ?? null, icon: 'smartphone' }] })
  await markPaid(client, sale.id)
}
collectionFailedHandlers.pos = async (client, op) => {
  const sale = await one(client, `UPDATE pos_sales SET status='failed' WHERE id=$1 AND status='pending' RETURNING *`, [op.purpose.saleId])
  if (sale) await notify(client, { userId: sale.user_id, template: 'pos.failed', text: `Paiement non abouti : ${sale.label}. Le client peut réessayer.`, dedupe: `pos-failed:${sale.id}` })
}
onRecordedConfirmed.pos = async (client, saleId) => { await markPaid(client, saleId) }
onRecordedRejected.pos = async (client, saleId) => { await client.query(`UPDATE pos_sales SET status='rejected' WHERE id=$1 AND status='pending'`, [saleId]) }

const fields = () => [amountField('Montant à encaisser'), textField('label', 'Pour quoi ?', { placeholder: 'Ex. Robe wax, 2 pagnes' }), phoneField('Numéro mobile money du client')]

export default {
  async view(ctx) {
    const k = await salesToday(ctx)
    const rows = (await all(ctx.client, 'SELECT * FROM pos_sales WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [ctx.user.id])).map(s => ({
      id: s.id, title: s.label, sub: `${s.customer_phone ?? ''} · ${ago(s.created_at)}`, value: ctx.f(s.amount), status: STATUS[s.status][0], tone: STATUS[s.status][1], icon: 'smartphone',
    }))
    return {
      blocks: [
        { type: 'kpis', title: "Aujourd'hui", items: [{ label: 'Ventes encaissées', value: String(k.n) }, { label: 'Montant', value: ctx.f(k.total), tone: 'ok' }, { label: 'En attente', value: String(k.waiting), tone: k.waiting ? 'wait' : '' }] },
        rowsBlock('Derniers encaissements', 'smartphone', rows, 'Aucun encaissement pour le moment.'),
        { type: 'note', title: 'Comment ça marche', text: ctx.held
          ? 'Saisissez le montant et le numéro du client : il reçoit une demande de paiement sur son téléphone et la valide avec son code mobile money. Votre solde est crédité dès que le partenaire confirme.'
          : 'Saisissez le montant : le client scanne le code avec son téléphone (ou reçoit le lien) et confirme. Le paiement se fait directement entre vous ; Nexus garde la preuve.' },
      ],
      actions: ctx.held ? ['charge'] : ['chargeRecorded'],
    }
  },
  widgets: {
    async kpis(ctx) { const k = await salesToday(ctx); return { type: 'kpis', title: "Encaissé aujourd'hui", items: [{ label: 'Ventes', value: String(k.n) }, { label: 'Montant', value: ctx.f(k.total), tone: 'ok' }] } },
  },
  actions: {
    // held: a payment request to the customer's mobile money, through the partner.
    charge: {
      label: 'Encaisser', icon: 'smartphone', custody: 'held',
      form: () => ({ title: 'Encaisser un client', info: config.sandbox ? 'Bac à sable : le partenaire est simulé, le client « valide » automatiquement en quelques secondes.' : 'Le client reçoit une demande de paiement sur son téléphone et la valide avec son code mobile money.', fields: fields() }),
      async run(ctx, input) {
        if (input.phone === ctx.user.phone) fail('Saisissez le numéro du client, pas le vôtre')
        const saleId = newId()
        const opId = await startCollection(ctx.client, { amount: input.amount, currency: ctx.cur.code, phone: input.phone, purpose: { type: 'pos', saleId, userId: ctx.user.id } })
        await ctx.client.query(`INSERT INTO pos_sales (id, user_id, amount, currency, label, customer_phone, mode, op_id) VALUES ($1,$2,$3,$4,$5,$6,'collection',$7)`,
          [saleId, ctx.user.id, input.amount, ctx.cur.code, input.label, input.phone, opId])
        return { message: `Demande de ${ctx.f(input.amount)} envoyée au ${input.phone}. Le client la valide sur son téléphone.` }
      },
    },
    // record: the customer confirms from a scanned code or a link; nothing moves through Nexus.
    chargeRecorded: {
      label: 'Encaisser', icon: 'smartphone', custody: 'record',
      form: () => ({ title: 'Encaisser un client', info: 'Le client vous paie directement (espèces ou mobile money), puis confirme en scannant le code. La preuve reste dans Nexus.', fields: fields() }),
      async run(ctx, input) {
        const customer = await ctx.findParty(input.phone)
        const saleId = newId()
        await ctx.client.query(`INSERT INTO pos_sales (id, user_id, amount, currency, label, customer_phone, mode) VALUES ($1,$2,$3,$4,$5,$6,'recorded')`,
          [saleId, ctx.user.id, input.amount, ctx.cur.code, input.label, normalizePhone(input.phone, ctx.region.dialCode)])
        const r = await recordPayment(ctx, { payerParty: customer, payeeParty: ctx.party, amount: input.amount, currency: ctx.cur.code, purpose: input.label, ref: `pos:${saleId}` })
        await ctx.client.query('UPDATE pos_sales SET recorded_id=$2 WHERE id=$1', [saleId, r.id])
        return { message: `Faites scanner le code à ${mask(customer.name)} : il confirme le paiement de ${ctx.f(input.amount)}.`, share: r.share }
      },
    },
  },
}
