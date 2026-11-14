import { randomInt } from 'node:crypto'
import { one, all } from '../db.js'
import { config } from '../config.js'
import { post, expand, legs, sys } from '../ledger.js'
import { fail, newId, mask, sha256, longDate } from '../core.js'
import { walletOf, balanceBlock, feedBlock, rowsBlock, partyById } from '../context.js'
import { startPayout, startCollection, collectionHandlers } from '../rails.js'
import { amountField, phoneField, textField, recordPayment, settleRecorded, pendingForMe, recordedRow } from './shared.js'
import { payOrderPlan, orderByCode } from './commerce.js'

const CASH_CODE_MIN = 15

// Money in from the user's own mobile money, through the partner. Credited when the partner confirms.
collectionHandlers.topup = async (client, op) => {
  const user = await one(client, 'SELECT * FROM users WHERE id=$1', [op.purpose.userId])
  await post(client, { kind: 'topup', idem: `topup:${op.id}`, lines: [
    { account: await sys(client, 'rail', op.currency), amount: -op.amount },
    { account: await walletOf(client, user), amount: op.amount, title: 'Dépôt depuis mobile money', icon: 'plus' }] })
}

function sendPlan(ctx, input) {
  return (async () => {
    const to = await ctx.findUser(input.phone)
    if (to.region !== ctx.user.region) fail(`${mask(to.name)} est dans un autre pays : passez par « Envoyer au pays ».`)
    const a = input.amount
    return {
      review: { lines: [['Destinataire', mask(to.name)], ['Montant', ctx.f(a)], ['Frais', ctx.f(0)], ['Total débité', ctx.f(a), true]], cta: `Envoyer ${ctx.f(a)}` },
      async exec() {
        const toParty = await one(ctx.client, 'SELECT * FROM parties WHERE user_id=$1', [to.id])
        await post(ctx.client, { kind: 'p2p', lines: await expand(ctx.client, [legs(await ctx.wallet(), await walletOf(ctx.client, to), a, a, {
          from: { title: input.note || 'Transfert envoyé', cpParty: toParty.id },
          to: { title: input.note || 'Transfert reçu', cpParty: ctx.party.id } })]) })
        return { message: `${ctx.f(a)} envoyés à ${mask(to.name)}` }
      },
    }
  })()
}

const myCodes = ctx => all(ctx.client, `SELECT * FROM cash_codes WHERE customer_id=$1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [ctx.user.id])

export default {
  async view(ctx) {
    const pending = (await pendingForMe(ctx)).map(r => recordedRow(ctx, r))
    if (!ctx.held) return {
      blocks: [await balanceBlock(ctx), rowsBlock('À confirmer', 'circle-help', pending), await feedBlock(ctx, 'Paiements enregistrés', 40),
        { type: 'note', title: 'Comment ça marche', text: 'Les paiements se font directement entre vous (espèces ou mobile money). Nexus garde la preuve : l’autre personne confirme, et chaque paiement confirmé compte pour votre réputation.' }],
      actions: ['recordIn', 'recordOut', 'goal'],
    }
    const codes = (await myCodes(ctx)).map(c => ({ id: c.id, title: 'Code de retrait actif', sub: `Valable jusqu’à ${new Date(c.expires_at).toTimeString().slice(0, 5)}`, value: ctx.f(c.amount), status: 'Chez un agent', tone: 'wait' }))
    return {
      blocks: [
        await balanceBlock(ctx),
        { type: 'note', title: 'Pour recevoir de l’argent', text: 'Donnez votre numéro Nexus :', copy: ctx.user.phone },
        rowsBlock('Retraits en cours', 'banknote', codes),
        rowsBlock('À confirmer', 'circle-help', pending),
        await feedBlock(ctx, 'Activité', 40),
      ],
      actions: ['send', 'pay', 'topup', 'withdraw', 'cashCode', 'bill', 'verify', 'recordIn', 'goal'],
    }
  },
  widgets: {
    // Progress toward the user's own monthly income target, from money actually received and confirmed.
    async goal(ctx) {
      const g = await one(ctx.client, 'SELECT amount FROM goals WHERE user_id=$1', [ctx.user.id])
      if (!g) return { type: 'note', text: 'Fixez votre objectif de revenu du mois et suivez où vous en êtes, paie après paie.' }
      const got = ctx.held
        ? (await one(ctx.client, `SELECT COALESCE(SUM(amount),0)::bigint AS n FROM postings WHERE account_id=$1 AND amount > 0 AND created_at > date_trunc('month', now())`, [(await ctx.wallet()).id])).n
        : (await one(ctx.client, `SELECT COALESCE(SUM(amount),0)::bigint AS n FROM recorded_payments WHERE payee_party=$1 AND status='confirmed' AND created_at > date_trunc('month', now())`, [ctx.party.id])).n
      return { type: 'goal', reached: got >= g.amount, main: got >= g.amount ? 'Objectif atteint' : `Encore ${ctx.f(g.amount - got)}`, detail: `${ctx.f(got)} reçus sur ${ctx.f(g.amount)}`, pct: Math.min(1, got / g.amount) }
    },
  },
  async insight(ctx) {
    const p = (await pendingForMe(ctx))[0]
    if (p) {
      const incoming = p.payee_party === ctx.party.id
      return { icon: 'circle-help', text: `${mask(incoming ? p.payer_name : p.payee_name)} ${incoming ? 'dit vous avoir payé' : 'dit avoir reçu de vous'} ${ctx.f(p.amount)} (${p.purpose}). Confirmez-vous ?`, cta: { label: 'Répondre', module: 'wallet' } }
    }
    return null
  },
  actions: {
    send: {
      label: 'Envoyer', icon: 'arrow-up-right', custody: 'held',
      form: () => ({ title: 'Envoyer de l’argent', fields: [amountField(), phoneField('Numéro du destinataire'), textField('note', 'Motif (facultatif)', { required: false })] }),
      plan: sendPlan,
    },
    pay: {
      label: 'Payer un code', icon: 'qr-code', custody: 'held',
      form: () => ({ title: 'Payer un code', fields: [textField('code', 'Code de paiement', { placeholder: 'Ex. 7KQ2M9XA4B', hint: 'Le code reçu du vendeur. Votre argent reste protégé jusqu’à la livraison.' })] }),
      plan: async (ctx, input) => payOrderPlan(ctx, await orderByCode(ctx.client, input.code)),
    },
    topup: {
      label: 'Approvisionner', icon: 'plus', custody: 'held',
      form: ctx => ({ title: 'Approvisionner depuis mobile money', info: config.sandbox ? 'Bac à sable : le partenaire est simulé, l’argent est fictif et crédité en quelques secondes.' : 'Une demande de paiement est envoyée sur votre téléphone par notre partenaire.', fields: [amountField()] }),
      plan: async (ctx, input) => ({
        review: { lines: [['Depuis', `Mobile money ${ctx.user.phone}`], ['Montant crédité', ctx.f(input.amount), true]], cta: `Demander ${ctx.f(input.amount)}` },
        async exec() {
          await startCollection(ctx.client, { amount: input.amount, currency: ctx.cur.code, phone: ctx.user.phone, partyId: ctx.party.id, purpose: { type: 'topup', userId: ctx.user.id } })
          return { message: 'Demande envoyée. Votre solde est crédité dès que le paiement est confirmé.' }
        },
      }),
    },
    withdraw: {
      label: 'Retirer', icon: 'banknote', custody: 'held',
      form: () => ({ title: 'Retirer vers mon mobile money', fields: [amountField()] }),
      plan: async (ctx, input) => ({
        review: { lines: [['Vers', `Mobile money ${ctx.user.phone}`], ['Montant', ctx.f(input.amount), true], ['Frais', ctx.f(0)]], cta: `Retirer ${ctx.f(input.amount)}` },
        async exec() {
          await startPayout(ctx.client, { source: await ctx.wallet(), amount: input.amount, phone: ctx.user.phone, userId: ctx.user.id, title: 'Retrait vers mobile money' })
          return { message: `${ctx.f(input.amount)} en route vers votre mobile money` }
        },
      }),
    },
    cashCode: {
      label: 'Retrait chez un agent', icon: 'banknote', custody: 'held',
      form: ctx => ctx.region.cashAgents ? { title: 'Retrait en espèces chez un agent', info: `Vous recevez un code valable ${CASH_CODE_MIN} minutes. Montrez-le à l’agent : il le saisit, et vous recevez les espèces.`, fields: [amountField()] }
        : { title: 'Retrait chez un agent', info: 'Pas encore de réseau d’agents dans votre pays.', fields: [], blocked: true },
      plan: async (ctx, input) => ({
        review: { lines: [['Montant en espèces', ctx.f(input.amount), true], ['Validité du code', `${CASH_CODE_MIN} minutes`]], cta: 'Créer le code' },
        async exec() {
          const code = String(randomInt(0, 1e8)).padStart(8, '0')
          await ctx.client.query(`INSERT INTO cash_codes (id, customer_id, code_hash, amount, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5))`,
            [newId(), ctx.user.id, sha256(`${code}:${config.linkSecret}`), input.amount, CASH_CODE_MIN])
          return { message: `Code de retrait pour ${ctx.f(input.amount)}. Ne le donnez qu’à l’agent, en face de vous.`, copy: code }
        },
      }),
    },
    bill: {
      label: 'Payer une facture', icon: 'receipt-text', custody: 'held',
      form: ctx => ctx.region.billers.length ? { title: 'Payer une facture', info: config.sandbox ? 'Bac à sable : aucun fournisseur n’est raccordé, le paiement est simulé.' : undefined, fields: [
        { name: 'biller', label: 'Fournisseur', type: 'select', options: ctx.region.billers.map(b => ({ value: b, label: b })) },
        textField('reference', 'Référence client'), amountField()] } : { title: 'Payer une facture', info: 'Aucun fournisseur disponible dans votre pays.', fields: [], blocked: true },
      plan: async (ctx, input) => ({
        review: { lines: [['Fournisseur', input.biller], ['Référence', input.reference], ['Total débité', ctx.f(input.amount), true]], cta: `Payer ${ctx.f(input.amount)}` },
        async exec() {
          await startPayout(ctx.client, { source: await ctx.wallet(), amount: input.amount, phone: `biller:${input.biller}:${input.reference}`, userId: ctx.user.id, title: `Facture ${input.biller}`, purpose: { biller: input.biller } })
          return { message: `Facture ${input.biller} en cours de paiement` }
        },
      }),
    },
    verify: {
      label: 'Vérifier mon identité', icon: 'id-card', custody: 'held',
      form: ctx => ctx.user.kyc_level >= 1 ? { title: 'Identité vérifiée', info: 'Votre identité est déjà vérifiée.', fields: [], blocked: true }
        : config.sandbox ? { title: 'Vérifier mon identité', info: 'Bac à sable : la vérification est simulée. En production, elle est faite par le partenaire agréé (pièce d’identité et selfie).', fields: [textField('idNumber', 'Numéro de pièce d’identité', { max: 30 })] }
          : { title: 'Vérifier mon identité', info: 'La vérification se fait chez notre partenaire agréé. Vous recevrez un lien par SMS.', fields: [], blocked: true },
      async run(ctx, input) {
        if (!config.sandbox) fail('Indisponible')
        await ctx.client.query('UPDATE users SET kyc_level=GREATEST(kyc_level,1) WHERE id=$1', [ctx.user.id])
        await ctx.audit('kyc.level', 'user', ctx.user.id, { level: 1, source: 'sandbox', idLast4: input.idNumber.slice(-4) })
        return { message: 'Identité vérifiée. Vos plafonds sont relevés.' }
      },
    },
    goal: {
      label: 'Objectif du mois', icon: 'trending-up',
      form: () => ({ title: 'Objectif de revenu du mois', fields: [amountField('Ce que vous visez ce mois-ci')] }),
      async run(ctx, input) {
        await ctx.client.query('INSERT INTO goals (user_id, amount) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET amount=EXCLUDED.amount', [ctx.user.id, input.amount])
        return { message: `Objectif fixé à ${ctx.f(input.amount)}` }
      },
    },
    recordIn: {
      label: 'Paiement reçu', icon: 'arrow-down-left',
      form: () => ({ title: 'Noter un paiement reçu', info: 'La personne qui vous a payé reçoit un lien pour confirmer.', fields: [amountField(), phoneField('Numéro de la personne qui a payé'), textField('name', 'Son nom', { required: false }), textField('purpose', 'Pour quoi ?')] }),
      async run(ctx, input) {
        const payer = await ctx.findParty(input.phone, input.name)
        const r = await recordPayment(ctx, { payerParty: payer, payeeParty: ctx.party, amount: input.amount, currency: ctx.cur.code, purpose: input.purpose })
        return { message: `Enregistré. ${mask(payer.name)} doit confirmer.`, share: r.share }
      },
    },
    recordOut: {
      label: 'Paiement fait', icon: 'arrow-up-right',
      form: () => ({ title: 'Noter un paiement fait', info: 'La personne payée reçoit un lien pour confirmer qu’elle a bien reçu.', fields: [amountField(), phoneField('Numéro de la personne payée'), textField('name', 'Son nom', { required: false }), textField('purpose', 'Pour quoi ?')] }),
      async run(ctx, input) {
        const payee = await ctx.findParty(input.phone, input.name)
        const r = await recordPayment(ctx, { payerParty: ctx.party, payeeParty: payee, amount: input.amount, currency: ctx.cur.code, purpose: input.purpose })
        return { message: `Enregistré. ${mask(payee.name)} doit confirmer.`, share: r.share }
      },
    },
    confirmRecorded: {
      label: 'Confirmer le paiement',
      form: () => ({ title: 'Confirmer le paiement', fields: [] }),
      async run(ctx, input, row) { await settleRecorded(ctx.client, row, ctx.party, true); return { message: 'Paiement confirmé' } },
    },
    rejectRecorded: {
      label: 'Refuser',
      form: () => ({ title: 'Refuser ce paiement', fields: [] }),
      async run(ctx, input, row) { await settleRecorded(ctx.client, row, ctx.party, false); return { message: 'Paiement refusé' } },
    },
  },
}

export { CASH_CODE_MIN }
export const fmtDate = longDate
export const partyName = async (client, id) => mask((await partyById(client, id)).name)
