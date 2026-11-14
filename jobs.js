import { one, all, transition } from '../db.js'
import { config } from '../config.js'
import { fail, newId, money, mask } from '../core.js'
import { rowsBlock, partyById, userById } from '../context.js'
import { notify, createLink, shareFor } from '../rails.js'
import { amountField, phoneField, textField, destinationOf, assertCorridor, recordPayment } from './shared.js'
import { REGIONS } from '../catalog.js'
import escrowModule, { createRequest, fundPlan, releaseEscrow, openDispute, loadEscrow, escrowHooks, modeFor } from './escrow.js'

const mine = ctx => all(ctx.client, 'SELECT * FROM jobs WHERE artisan_party=$1 OR client_party=$1 ORDER BY created_at DESC', [ctx.party.id])
export const stagesOf = (client, jobId) => all(client, 'SELECT * FROM job_stages WHERE job_id=$1 ORDER BY position', [jobId])
const current = stages => stages.find(s => s.status !== 'paid')
const roleOf = (job, party) => (job.artisan_party === party.id ? 'artisan' : job.client_party === party.id ? 'client' : null)

const LABELS = {
  held: { planned: ['À lancer', ''], requested: ['Financement demandé', 'wait'], funded: ['Financée', 'ok'], done: ['À valider', 'wait'], disputed: ['Litige', 'bad'] },
  recorded: { planned: ['En cours', ''], done: ['À valider', 'wait'], validated: ['À payer', 'wait'], claimed: ['Paiement signalé', 'wait'], disputed: ['Litige', 'bad'] },
}
// The next step for each side, by custody mode and stage status.
const NEXT = {
  held: {
    artisan: { planned: { id: 'request', label: 'Demander le financement', tone: 'primary' }, funded: { id: 'done', label: 'Étape terminée', tone: 'primary' } },
    client: { requested: { id: 'fund', label: 'Financer l’étape', tone: 'primary' }, done: { id: 'validate', label: 'Valider et payer', tone: 'primary' } },
  },
  recorded: {
    artisan: { planned: { id: 'done', label: 'Étape terminée', tone: 'primary' }, validated: { id: 'markReceived', label: 'Paiement reçu', tone: 'primary' }, claimed: { id: 'markReceived', label: 'Confirmer la réception', tone: 'primary' } },
    client: { done: { id: 'validate', label: 'Valider l’étape', tone: 'primary' }, validated: { id: 'claimPaid', label: 'J’ai payé', tone: 'primary' } },
  },
}

export async function jobRow(client, job, party) {
  const stages = await stagesOf(client, job.id), stage = current(stages), role = roleOf(job, party)
  const other = await partyById(client, role === 'artisan' ? job.client_party : job.artisan_party)
  const total = stages.reduce((s, x) => s + x.amount, 0), paid = stages.filter(s => s.status === 'paid').reduce((s, x) => s + x.amount, 0)
  const base = { id: job.id, title: job.title, value: money(total, job.currency), progress: total ? paid / total : 0 }
  if (!stage) return { ...base, sub: `${mask(other.name)} · ${stages.length} étapes payées`, status: 'Terminé', tone: 'ok' }
  const [status, tone] = LABELS[job.mode][stage.status] ?? ['', '']
  const next = NEXT[job.mode][role]?.[stage.status]
  const actions = [next, ...(job.mode === 'held' && ['funded', 'done'].includes(stage.status) ? [{ id: 'dispute', label: 'Litige' }] : []), { id: 'share', label: 'Lien pour ' + (role === 'artisan' ? 'le client' : 'l’artisan') }].filter(Boolean)
  const proofs = stage.proof.length ? ` · ${stage.proof.length} photo${stage.proof.length > 1 ? 's' : ''}` : ''
  return { ...base, sub: `${mask(other.name)} · étape ${stage.position}/${stages.length} : ${stage.title} (${money(stage.amount, job.currency)})${proofs}`, status, tone, actions, proof: stage.proof }
}

// Loads the job's current stage and checks the caller's role and the stage state.
export async function step(client, jobId, party, role, statuses) {
  const job = await one(client, 'SELECT * FROM jobs WHERE id=$1', [jobId])
  if (!job || roleOf(job, party) !== role) fail('Action non autorisée', 403)
  const stage = current(await stagesOf(client, job.id))
  if (!stage || ![statuses].flat().includes(stage.status)) fail('Cette action n’est plus possible', 409)
  return { job, stage }
}
const setStage = (client, stage, from, to, extra) => transition(client, 'job_stages', stage.id, from, to, extra)

escrowHooks.stage.funded = (c, e) => c.query(`UPDATE job_stages SET status='funded' WHERE id=$1 AND status='requested'`, [e.stage_id])
escrowHooks.stage.released = (c, e) => c.query(`UPDATE job_stages SET status='paid' WHERE id=$1`, [e.stage_id])
escrowHooks.stage.paid = (c, e) => c.query(`UPDATE job_stages SET status='paid' WHERE id=$1`, [e.stage_id])
escrowHooks.stage.refunded = (c, e) => c.query(`UPDATE job_stages SET status='planned', escrow_id=NULL WHERE id=$1`, [e.stage_id])
escrowHooks.stage.cancelled = escrowHooks.stage.refunded
escrowHooks.stage.disputed = (c, e) => c.query(`UPDATE job_stages SET status='disputed' WHERE id=$1`, [e.stage_id])

// Party-level operations, shared by the app and the public link page.
export const jobOps = {
  // The artisan asks the client to put the next stage's money in escrow (held jobs only).
  async requestFunding(client, jobId, party) {
    const { job, stage } = await step(client, jobId, party, 'artisan', 'planned')
    if (job.mode !== 'held') fail('Ce chantier est payé en direct')
    const clientParty = await partyById(client, job.client_party)
    const r = await createRequest(client, { payee: party, payer: clientParty, amount: stage.amount, currency: job.currency, title: `${job.title} · ${stage.title}`, mode: 'held', stageId: stage.id })
    await setStage(client, stage, 'planned', 'requested', { escrow_id: r.id })
    return { share: r.share, clientName: clientParty.name }
  },
  async markDone(client, jobId, party, proofId = null) {
    const { job, stage } = await step(client, jobId, party, 'artisan', ['funded', 'planned'])
    if (job.mode === 'held' && stage.status !== 'funded') fail('L’étape doit d’abord être financée', 409)
    if (job.mode === 'recorded' && stage.status !== 'planned') fail('Cette action n’est plus possible', 409)
    await setStage(client, stage, stage.status, 'done', { done_at: new Date(), proof: proofId ? [...stage.proof, proofId] : stage.proof })
    if (job.mode === 'held') await client.query(`UPDATE escrows SET auto_release_at = now() + make_interval(days => $2) WHERE id=$1`, [stage.escrow_id, config.autoReleaseDays])
    const url = await createLink(client, { kind: 'job', refId: job.id, partyId: job.client_party })
    const auto = job.mode === 'held' ? ` Sans réponse, le paiement part automatiquement dans ${config.autoReleaseDays} jours.` : ''
    await notify(client, { partyId: job.client_party, template: 'job.done', text: `L’étape « ${stage.title} » de « ${job.title} » est terminée${proofId ? ', photo à l’appui' : ''}. Vérifiez et validez.${auto}`, link: url })
  },
  async validateRecorded(client, jobId, party) {
    const { job, stage } = await step(client, jobId, party, 'client', 'done')
    if (job.mode !== 'recorded') fail('Utilisez « Valider et payer »')
    const artisan = await partyById(client, job.artisan_party)
    const { id } = await createRequest(client, { payee: artisan, payer: party, amount: stage.amount, currency: job.currency, title: `${job.title} · ${stage.title}`, mode: 'recorded', stageId: stage.id, notifyPayer: false })
    await setStage(client, stage, 'done', 'validated', { escrow_id: id })
    await notify(client, { partyId: job.artisan_party, template: 'job.validated', text: `${mask(party.name)} a validé l’étape « ${stage.title} ». Paiement attendu : ${money(stage.amount, job.currency)}.` })
  },
}

export default {
  async view(ctx) {
    const rows = await Promise.all((await mine(ctx)).map(j => jobRow(ctx.client, j, ctx.party)))
    return { blocks: [rowsBlock('Chantiers', 'hard-hat', rows, 'Aucun chantier pour le moment.')], actions: ['create', 'crew'] }
  },
  widgets: {
    rows: async ctx => rowsBlock(null, 'hard-hat', (await Promise.all((await mine(ctx)).map(j => jobRow(ctx.client, j, ctx.party)))).filter(r => r.status !== 'Terminé').slice(0, 3)),
  },
  async insight(ctx) {
    for (const job of await mine(ctx)) {
      const stage = current(await stagesOf(ctx.client, job.id)); if (!stage) continue
      const role = roleOf(job, ctx.party), next = NEXT[job.mode][role]?.[stage.status]
      if (!next) continue
      const other = mask((await partyById(ctx.client, role === 'artisan' ? job.client_party : job.artisan_party)).name)
      const amount = money(stage.amount, job.currency)
      const texts = {
        validate: `${other} a terminé l’étape « ${stage.title} ». Vérifiez et validez (${amount}).`,
        fund: `${other} demande le financement de l’étape « ${stage.title} » : ${amount}.`,
        done: `L’étape « ${stage.title} » est prête. Signalez-la terminée avec une photo.`,
        claimPaid: `Étape « ${stage.title} » validée : payez ${amount} à ${other}, puis signalez-le.`,
        markReceived: `Confirmez avoir reçu ${amount} pour « ${stage.title} ».`,
        request: `Demandez le financement de l’étape « ${stage.title} » (${amount}) à ${other}.`,
      }
      return { icon: 'badge-check', text: texts[next.id], cta: { label: next.label, module: 'jobs', action: next.id, row: job.id } }
    }
    return null
  },
  actions: {
    create: {
      label: 'Nouveau chantier', icon: 'plus',
      form: ctx => {
        const asClient = ctx.persona.jobRole === 'client'
        const countries = [ctx.user.region, ...ctx.region.corridors].map(id => ({ value: id, label: REGIONS[id].name }))
        return { title: 'Nouveau chantier', info: 'Découpez le chantier en étapes. Chaque étape est validée avec une photo avant d’être payée. L’autre personne n’a pas besoin de l’application.', fields: [
          textField('title', 'Nom du chantier'),
          ...(asClient ? [{ name: 'country', label: 'Pays du chantier', type: 'select', options: countries }] : []),
          phoneField(asClient ? 'Numéro de l’artisan' : 'Numéro du client'), textField('name', asClient ? 'Nom de l’artisan' : 'Nom du client', { required: false }),
          ...[1, 2, 3, 4].flatMap(i => [textField(`stage${i}`, `Étape ${i}`, { required: i === 1 }),
            amountField(`Montant de l’étape ${i}${asClient ? ' (devise du pays du chantier)' : ''}`, { name: `amount${i}`, required: i === 1, ...(asClient ? { currencyField: 'country' } : {}) })])] }
      },
      async run(ctx, input) {
        const other = await ctx.findParty(input.phone, input.name)
        const asClient = ctx.persona.jobRole === 'client'
        const clientParty = asClient ? ctx.party : other, artisanParty = asClient ? other : ctx.party
        const clientUser = clientParty.user_id ? await userById(ctx.client, clientParty.user_id) : null
        const mode = modeFor(clientParty, clientUser)
        let currency = ctx.cur.code
        if (asClient) {
          // A diaspora client pays an artisan abroad: the job runs in the artisan's currency, on a corridor the client's country has opened.
          const dest = await destinationOf(ctx.client, other)
          if (dest.region !== input.country) fail(`Le numéro de l’artisan ne correspond pas au pays choisi (${REGIONS[input.country].name})`)
          if (dest.region !== ctx.user.region) assertCorridor(ctx, dest.region, 'escrow')
          currency = dest.currency
        }
        const stages = [1, 2, 3, 4].filter(i => input[`stage${i}`] && input[`amount${i}`]).map(i => [input[`stage${i}`], input[`amount${i}`]])
        const id = newId()
        await ctx.client.query('INSERT INTO jobs (id, artisan_party, client_party, created_by, title, currency, mode) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, artisanParty.id, clientParty.id, ctx.user.id, input.title, currency, mode])
        for (const [i, [title, amount]] of stages.entries()) await ctx.client.query('INSERT INTO job_stages (id, job_id, position, title, amount) VALUES ($1,$2,$3,$4,$5)', [newId(), id, i + 1, title, amount])
        const url = await createLink(ctx.client, { kind: 'job', refId: id, partyId: other.id })
        const text = `${mask(ctx.user.name)} a créé le chantier « ${input.title} » avec vous (${stages.length} étape${stages.length > 1 ? 's' : ''}). Suivez-le ici, sans application :`
        await notify(ctx.client, { partyId: other.id, template: 'job.created', text, link: url })
        return { message: `Chantier créé avec ${mask(other.name)}`, share: shareFor(text, url) }
      },
    },
    crew: {
      label: 'Payer l’équipe', icon: 'users-round',
      form: () => ({ title: 'Payer l’équipe', info: 'Vous payez vos ouvriers comme d’habitude (espèces ou mobile money). Chacun reçoit un lien pour confirmer : il garde une preuve de sa paie, vous une preuve de paiement.', fields: [
        amountField('Paie par personne'), textField('phones', 'Numéros des ouvriers', { max: 300, hint: 'Séparés par des virgules, 15 au plus.' }), textField('purpose', 'Motif', { placeholder: 'Journée du 14, chantier Maârif' })] }),
      async run(ctx, input) {
        const phones = [...new Set(input.phones.split(/[,;\n]/).map(x => x.trim()).filter(Boolean))]
        if (!phones.length || phones.length > 15) fail('Entre 1 et 15 ouvriers')
        let share
        for (const p of phones) {
          const worker = await ctx.findParty(p)
          const r = await recordPayment(ctx, { payerParty: ctx.party, payeeParty: worker, amount: input.amount, currency: ctx.cur.code, purpose: input.purpose })
          share ??= r.share
        }
        return { message: `${phones.length} paie${phones.length > 1 ? 's' : ''} de ${ctx.f(input.amount)} enregistrée${phones.length > 1 ? 's' : ''}. Chaque ouvrier doit confirmer.`, share: phones.length === 1 ? share : undefined }
      },
    },
    request: {
      // Allowed from any country: whether money can be held depends on the job's client (job.mode), checked below.
      label: 'Demander le financement', form: () => ({ title: 'Demander le financement', fields: [] }),
      async run(ctx, input, jobId) {
        const r = await jobOps.requestFunding(ctx.client, jobId, ctx.party)
        return { message: `Demande envoyée à ${mask(r.clientName)}`, share: r.share }
      },
    },
    fund: {
      label: 'Financer l’étape', custody: 'held', form: () => ({ title: 'Financer l’étape', fields: [] }),
      async plan(ctx, input, jobId) {
        const { stage } = await step(ctx.client, jobId, ctx.party, 'client', 'requested')
        return fundPlan(ctx, await loadEscrow(ctx.client, stage.escrow_id))
      },
    },
    done: {
      label: 'Étape terminée', form: () => ({ title: 'Étape terminée', info: 'Ajoutez une photo prise sur le chantier : le client la voit avant de valider.', fields: [{ name: 'proof', label: 'Photo du chantier', type: 'upload', required: false }] }),
      async run(ctx, input, jobId) { await jobOps.markDone(ctx.client, jobId, ctx.party, input.proof ?? null); return { message: 'Le client est invité à valider l’étape' } },
    },
    validate: {
      label: 'Valider', form: () => ({ title: 'Valider l’étape', fields: [] }),
      // Held: validation releases the money (quote + PIN). Recorded: validation asks for direct payment.
      async plan(ctx, input, jobId) {
        const job = await one(ctx.client, 'SELECT * FROM jobs WHERE id=$1', [jobId])
        if (job?.mode === 'recorded') {
          const { stage } = await step(ctx.client, jobId, ctx.party, 'client', 'done')
          return { review: { lines: [['Étape', stage.title], ['À payer en direct à l’artisan', money(stage.amount, job.currency), true]], cta: 'Valider l’étape' }, async exec() { await jobOps.validateRecorded(ctx.client, jobId, ctx.party); return { message: 'Étape validée. Payez l’artisan puis signalez-le.' } } }
        }
        const { stage } = await step(ctx.client, jobId, ctx.party, 'client', 'done')
        const e = await loadEscrow(ctx.client, stage.escrow_id)
        const artisan = await partyById(ctx.client, job.artisan_party)
        return {
          review: { lines: [['Artisan', mask(artisan.name)], ['Étape', stage.title], ['Montant versé', money(e.amount, e.currency), true]], cta: `Valider et verser ${money(e.amount, e.currency)}` },
          async exec() { await releaseEscrow(ctx.client, e, 'Étape validée'); return { message: `${money(e.amount, e.currency)} versés à ${mask(artisan.name)}` } },
        }
      },
    },
    claimPaid: {
      label: 'J’ai payé', form: () => ({ title: 'Signaler le paiement', fields: [] }),
      async run(ctx, input, jobId) { const { stage } = await step(ctx.client, jobId, ctx.party, 'client', 'validated'); await escrowModule.actions.claimPaid.run(ctx, {}, stage.escrow_id); await setStage(ctx.client, stage, 'validated', 'claimed'); return { message: 'Paiement signalé. L’artisan doit confirmer.' } },
    },
    markReceived: {
      label: 'Paiement reçu', form: () => ({ title: 'Confirmer la réception', fields: [] }),
      async run(ctx, input, jobId) { const { stage } = await step(ctx.client, jobId, ctx.party, 'artisan', ['validated', 'claimed']); await escrowModule.actions.markReceived.run(ctx, {}, stage.escrow_id); return { message: 'Réception confirmée' } },
    },
    dispute: {
      label: 'Litige', form: () => ({ title: 'Signaler un litige', info: 'Les fonds restent bloqués. Notre équipe examine les photos et les explications des deux côtés.', fields: [{ name: 'reason', label: 'Que s’est-il passé ?', type: 'text', max: 300 }] }),
      async run(ctx, input, jobId) {
        const job = await one(ctx.client, 'SELECT * FROM jobs WHERE id=$1', [jobId])
        const role = job && roleOf(job, ctx.party)
        if (!role) fail('Action non autorisée', 403)
        const { stage } = await step(ctx.client, jobId, ctx.party, role, ['funded', 'done'])
        await openDispute(ctx.client, await loadEscrow(ctx.client, stage.escrow_id), ctx.party, input.reason)
        return { message: 'Litige ouvert. Les fonds restent bloqués.' }
      },
    },
    share: {
      label: 'Partager le lien', form: () => ({ title: 'Lien du chantier', fields: [] }),
      async run(ctx, input, jobId) {
        const job = await one(ctx.client, 'SELECT * FROM jobs WHERE id=$1', [jobId])
        const role = job && roleOf(job, ctx.party)
        if (!role) fail('Action non autorisée', 403)
        const url = await createLink(ctx.client, { kind: 'job', refId: job.id, partyId: role === 'artisan' ? job.client_party : job.artisan_party })
        return { message: 'Lien prêt à partager', share: shareFor(`Suivez le chantier « ${job.title} » :`, url) }
      },
    },
  },
}
