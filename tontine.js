import { randomInt } from 'node:crypto'
import { one, all, transition } from '../db.js'
import { REGIONS } from '../catalog.js'
import { post, account, sys } from '../ledger.js'
import { fail, newId, money, mask, today, longDate } from '../core.js'
import { rowsBlock, partyById } from '../context.js'
import { notify, createLink, shareFor, startCollection, collectionHandlers } from '../rails.js'
import { amountField, textField, deliver, regionOfPhone, recordPayment, settleRecorded, onRecordedConfirmed, onRecordedRejected, returnCollection } from './shared.js'

const PERIOD_DAYS = { weekly: 7, monthly: 30 }
const potAccount = (client, t) => account(client, `tontine:${t.id}`, 'pot', t.currency)
export const membersOf = (client, t) => all(client, `SELECT m.*, p.name, p.phone, p.user_id FROM tontine_members m JOIN parties p ON p.id=m.party_id WHERE m.tontine_id=$1 ORDER BY m.position NULLS LAST, p.name`, [t.id])
const contribsOf = (client, t) => all(client, `SELECT * FROM tontine_contribs WHERE tontine_id=$1 AND round=$2`, [t.id, t.round])
const mine = ctx => all(ctx.client, `SELECT t.* FROM tontines t JOIN tontine_members m ON m.tontine_id=t.id WHERE m.party_id=$1 ORDER BY t.created_at DESC`, [ctx.party.id])
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

export async function loadTontine(client, id, party) {
  const t = await one(client, 'SELECT * FROM tontines WHERE id=$1', [id])
  if (!t) fail('Groupe introuvable', 404)
  const m = await one(client, 'SELECT * FROM tontine_members WHERE tontine_id=$1 AND party_id=$2', [id, party.id])
  if (!m) fail('Vous ne faites pas partie de ce groupe', 403)
  return { t, member: m }
}

// Members accept before anything starts; once all have, the payout order is drawn and the first round opens.
export async function acceptInvite(client, id, party) {
  const { t, member } = await loadTontine(client, id, party)
  if (t.status !== 'forming') fail('Ce groupe a déjà démarré', 409)
  if (!member.accepted_at) await client.query('UPDATE tontine_members SET accepted_at=now() WHERE tontine_id=$1 AND party_id=$2', [id, party.id])
  const members = await membersOf(client, t)
  if (members.every(m => m.accepted_at || m.party_id === party.id)) {
    const order = members.map(m => m.party_id)
    for (let i = order.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [order[i], order[j]] = [order[j], order[i]] }
    for (const [i, pid] of order.entries()) await client.query('UPDATE tontine_members SET position=$3 WHERE tontine_id=$1 AND party_id=$2', [id, pid, i + 1])
    await transition(client, 'tontines', id, 'forming', 'active', { next_due: addDays(today(), PERIOD_DAYS[t.frequency]) })
    for (const pid of order) await notify(client, { partyId: pid, template: 'tontine.start', text: `Le groupe « ${t.name} » démarre. L’ordre des tours a été tiré au sort ; première cotisation de ${money(t.amount, t.currency)} avant le ${longDate(addDays(today(), PERIOD_DAYS[t.frequency]))}.` })
  }
}

async function completeRoundIfFull(client, t) {
  const confirmed = (await contribsOf(client, t)).filter(c => c.status === 'confirmed')
  if (confirmed.length < t.size) return null
  const receiver = (await membersOf(client, t)).find(m => m.position === t.round)
  const total = t.amount * t.size
  if (t.mode === 'held') {
    await deliver(client, { source: await potAccount(client, t), amount: total, toParty: await partyById(client, receiver.party_id), title: `Cagnotte ${t.name} (tour ${t.round})`, purpose: { tontineId: t.id, round: t.round }, kind: 'tontine_out' })
  }
  const last = t.round === t.size
  await client.query(`UPDATE tontines SET round=$2, status=$3, next_due=$4 WHERE id=$1`, [t.id, last ? t.round : t.round + 1, last ? 'completed' : 'active', last ? null : addDays(t.next_due ?? today(), PERIOD_DAYS[t.frequency])])
  await notify(client, { partyId: receiver.party_id, template: 'tontine.pot', text: t.mode === 'held' ? `Tour complet : vous recevez la cagnotte de ${money(total, t.currency)} (« ${t.name} »).` : `Tour complet : l’organisateur doit vous remettre la cagnotte de ${money(total, t.currency)} (« ${t.name} »).` })
  return receiver
}

// Held mode: a member's contribution lands in the group's own pot account.
async function creditContribution(client, t, partyId, sourceLines) {
  await post(client, { kind: 'tontine_in', lines: [...sourceLines, { account: await potAccount(client, t), amount: t.amount }] })
  await client.query(`INSERT INTO tontine_contribs (tontine_id, round, party_id, status, confirmed_at) VALUES ($1,$2,$3,'confirmed', now())`, [t.id, t.round, partyId])
  return completeRoundIfFull(client, t)
}
collectionHandlers.tontine = async (client, op) => {
  const t = await one(client, 'SELECT * FROM tontines WHERE id=$1 FOR UPDATE', [op.purpose.tontineId])
  if (t.round !== op.purpose.round || await one(client, 'SELECT 1 FROM tontine_contribs WHERE tontine_id=$1 AND round=$2 AND party_id=$3', [t.id, t.round, op.party_id])) {
    return returnCollection(client, op, `cotisation ${t.name}`)
  }
  await creditContribution(client, t, op.party_id, [{ account: await sys(client, 'rail', op.currency), amount: -op.amount }])
}
onRecordedRejected.tontine = async (client, ref, rp) => {
  const [id, round] = ref.split('@')
  await client.query(`DELETE FROM tontine_contribs WHERE tontine_id=$1 AND round=$2 AND party_id=$3 AND status='claimed'`, [id, Number(round), rp.payer_party])
}
onRecordedConfirmed.tontine = async (client, ref, rp) => {
  const [id, round] = ref.split('@')
  const t = await one(client, 'SELECT * FROM tontines WHERE id=$1 FOR UPDATE', [id])
  await client.query(`UPDATE tontine_contribs SET status='confirmed', confirmed_at=now() WHERE tontine_id=$1 AND round=$2 AND party_id=$3`, [id, Number(round), rp.payer_party])
  await completeRoundIfFull(client, t)
}

// Party-level operations, shared by the app and the public link page.
export const tontineOps = {
  acceptInvite,
  async payByCollection(client, id, party, phone) {
    const { t } = await loadTontine(client, id, party)
    if (t.mode !== 'held' || t.status !== 'active') fail('Cette cotisation ne passe pas par le partenaire', 409)
    if (await one(client, 'SELECT 1 FROM tontine_contribs WHERE tontine_id=$1 AND round=$2 AND party_id=$3', [t.id, t.round, party.id])) fail('Cotisation déjà versée pour ce tour')
    return startCollection(client, { amount: t.amount, currency: t.currency, phone, partyId: party.id, purpose: { type: 'tontine', tontineId: t.id, round: t.round } })
  },
}

async function row(ctx, t) {
  const f = n => money(n, t.currency)
  const members = await membersOf(ctx.client, t)
  const me = members.find(m => m.party_id === ctx.party.id)
  const organiser = t.organiser_id === ctx.user.id
  if (t.status === 'forming') {
    const accepted = members.filter(m => m.accepted_at).length
    return { id: t.id, title: t.name, value: f(t.amount), sub: `${accepted}/${members.length} membres ont accepté · ${t.frequency === 'weekly' ? 'chaque semaine' : 'chaque mois'}`,
      status: me.accepted_at ? 'En attente des autres' : 'Invitation', tone: 'wait', progress: accepted / members.length,
      actions: me.accepted_at ? [{ id: 'invite', label: 'Relancer' }] : [{ id: 'accept', label: 'Accepter', tone: 'primary' }] }
  }
  if (t.status === 'completed') return { id: t.id, title: t.name, sub: `${t.size} tours terminés`, value: f(t.amount), status: 'Terminée', tone: 'ok', progress: 1 }
  const contribs = await contribsOf(ctx.client, t)
  const confirmed = contribs.filter(c => c.status === 'confirmed')
  const receiver = members.find(m => m.position === t.round)
  const mineC = contribs.find(c => c.party_id === ctx.party.id)
  const late = t.next_due && t.next_due < today()
  const actions = []
  if (!mineC) actions.push({ id: 'contribute', label: t.mode === 'held' ? 'Cotiser' : 'J’ai cotisé', tone: 'primary' })
  if (organiser && t.mode === 'recorded' && contribs.some(c => c.status === 'claimed')) actions.push({ id: 'review', label: 'Confirmer les cotisations', tone: 'primary' })
  return {
    id: t.id, title: t.name, value: f(t.amount), progress: confirmed.length / t.size,
    sub: `Tour ${t.round}/${t.size} · ${receiver.party_id === ctx.party.id ? 'vous recevez' : `${mask(receiver.name)} reçoit`} ${f(t.amount * t.size)} · avant le ${longDate(t.next_due)}`,
    status: mineC?.status === 'confirmed' ? 'Cotisé' : mineC ? 'À confirmer' : late ? 'En retard' : 'À cotiser', tone: mineC?.status === 'confirmed' ? 'ok' : late ? 'bad' : 'wait', actions,
  }
}

export default {
  async view(ctx) {
    const rows = await Promise.all((await mine(ctx)).map(t => row(ctx, t)))
    return { blocks: [rowsBlock('Vos groupes', 'users-round', rows, 'Vous ne faites partie d’aucun groupe.'),
      { type: 'note', title: 'Règles du groupe', text: 'Chacun accepte avant le départ, l’ordre des tours est tiré au sort, et chaque cotisation est confirmée. Les retards sont visibles par tous les membres.' }], actions: ['create'] }
  },
  widgets: { rows: async ctx => rowsBlock(null, 'users-round', await Promise.all((await mine(ctx)).slice(0, 3).map(t => row(ctx, t)))) },
  async insight(ctx) {
    for (const t of await mine(ctx)) {
      const m = await one(ctx.client, 'SELECT * FROM tontine_members WHERE tontine_id=$1 AND party_id=$2', [t.id, ctx.party.id])
      if (t.status === 'forming' && !m.accepted_at) return { icon: 'users-round', text: `Vous êtes invité dans le groupe « ${t.name} » (${money(t.amount, t.currency)} par tour).`, cta: { label: 'Accepter', module: 'tontine', action: 'accept', row: t.id } }
      if (t.status === 'active' && !await one(ctx.client, 'SELECT 1 FROM tontine_contribs WHERE tontine_id=$1 AND round=$2 AND party_id=$3', [t.id, t.round, ctx.party.id]))
        return { icon: 'users-round', text: `Cotisation « ${t.name} » du tour ${t.round} attendue avant le ${longDate(t.next_due)} : ${money(t.amount, t.currency)}.`, cta: { label: 'Cotiser', module: 'tontine', action: 'contribute', row: t.id } }
    }
    return null
  },
  actions: {
    create: {
      label: 'Nouveau groupe', icon: 'plus',
      form: ctx => ({ title: 'Nouveau groupe', info: 'Les membres reçoivent une invitation, même sans l’application. Le groupe démarre quand tout le monde a accepté ; l’ordre des tours est tiré au sort.', fields: [
        textField('name', 'Nom du groupe'), amountField('Cotisation par tour'),
        { name: 'frequency', label: 'Rythme', type: 'select', options: [{ value: 'monthly', label: 'Chaque mois' }, { value: 'weekly', label: 'Chaque semaine' }] },
        textField('members', 'Numéros des autres membres', { max: 300, hint: `Séparés par des virgules. Tous doivent être en ${ctx.region.name}.` })] }),
      async run(ctx, input) {
        const phones = input.members.split(/[,;\n]/).map(s => s.trim()).filter(Boolean)
        if (phones.length < 1 || phones.length > 29) fail('Entre 2 et 30 membres au total')
        const others = []
        for (const p of phones) others.push(await ctx.findParty(p))
        if (new Set(others.map(o => o.id)).size !== others.length) fail('Un numéro est en double')
        if (others.some(o => regionOfPhone(o.phone) !== ctx.user.region)) fail('Tous les membres doivent être dans le même pays')
        const id = newId()
        await ctx.client.query(`INSERT INTO tontines (id, name, currency, amount, organiser_id, frequency, size, status, mode) VALUES ($1,$2,$3,$4,$5,$6,$7,'forming',$8)`,
          [id, input.name, ctx.cur.code, input.amount, ctx.user.id, input.frequency, others.length + 1, ctx.held ? 'held' : 'recorded'])
        await ctx.client.query('INSERT INTO tontine_members (tontine_id, party_id, accepted_at) VALUES ($1,$2, now())', [id, ctx.party.id])
        let share
        for (const o of others) {
          await ctx.client.query('INSERT INTO tontine_members (tontine_id, party_id) VALUES ($1,$2)', [id, o.id])
          const url = await createLink(ctx.client, { kind: 'tontine', refId: id, partyId: o.id })
          const text = `${mask(ctx.user.name)} vous invite dans le groupe « ${input.name} » : ${ctx.f(input.amount)} ${input.frequency === 'weekly' ? 'chaque semaine' : 'chaque mois'}, ${others.length + 1} membres. Acceptez ici :`
          await notify(ctx.client, { partyId: o.id, template: 'tontine.invite', text, link: url })
          share ??= shareFor(text, url)
        }
        return { message: `Groupe « ${input.name} » créé. Il démarre quand les ${others.length} autres membres auront accepté.`, share }
      },
    },
    accept: { label: 'Accepter', form: () => ({ title: 'Rejoindre le groupe', fields: [] }), async run(ctx, input, id) { await acceptInvite(ctx.client, id, ctx.party); return { message: 'Vous avez rejoint le groupe' } } },
    invite: {
      label: 'Relancer', form: () => ({ title: 'Relancer les invitations', fields: [] }),
      async run(ctx, input, id) {
        const { t } = await loadTontine(ctx.client, id, ctx.party)
        const pending = (await membersOf(ctx.client, t)).filter(m => !m.accepted_at)
        for (const m of pending) await notify(ctx.client, { partyId: m.party_id, template: 'tontine.invite', text: `Rappel : rejoignez le groupe « ${t.name} ».`, link: await createLink(ctx.client, { kind: 'tontine', refId: t.id, partyId: m.party_id }) })
        return { message: `${pending.length} relance${pending.length > 1 ? 's' : ''} envoyée${pending.length > 1 ? 's' : ''}` }
      },
    },
    contribute: {
      label: 'Cotiser', icon: 'users-round',
      async form(ctx, row) {
        if (row) return { title: 'Cotiser', fields: [] }
        const open = []
        for (const t of await mine(ctx)) if (t.status === 'active' && !await one(ctx.client, 'SELECT 1 FROM tontine_contribs WHERE tontine_id=$1 AND round=$2 AND party_id=$3', [t.id, t.round, ctx.party.id])) open.push(t)
        if (!open.length) return { title: 'Cotiser', info: 'Vous êtes à jour : aucune cotisation à faire.', fields: [], blocked: true }
        return { title: 'Cotiser', fields: [{ name: 'tontine', label: 'Groupe', type: 'select', options: open.map(t => ({ value: t.id, label: `${t.name} · ${money(t.amount, t.currency)}` })) }] }
      },
      async plan(ctx, input, row) {
        const { t } = await loadTontine(ctx.client, row ?? input.tontine, ctx.party)
        if (t.status !== 'active') fail('Ce groupe n’est pas actif', 409)
        if (await one(ctx.client, 'SELECT 1 FROM tontine_contribs WHERE tontine_id=$1 AND round=$2 AND party_id=$3', [t.id, t.round, ctx.party.id])) fail('Cotisation déjà faite pour ce tour')
        const f = n => money(n, t.currency)
        const organiser = await one(ctx.client, 'SELECT p.* FROM parties p WHERE p.user_id=$1', [t.organiser_id])
        if (t.mode === 'recorded') return {
          review: { lines: [['Groupe', t.name], ['Tour', `${t.round} sur ${t.size}`], [`Payé en direct à ${mask(organiser.name)}`, f(t.amount), true]], cta: 'Signaler ma cotisation' },
          async exec() {
            if (organiser.id === ctx.party.id) {
              await ctx.client.query(`INSERT INTO tontine_contribs (tontine_id, round, party_id, status, confirmed_at) VALUES ($1,$2,$3,'confirmed', now())`, [t.id, t.round, ctx.party.id])
              await completeRoundIfFull(ctx.client, t)
              return { message: 'Votre cotisation est notée' }
            }
            await ctx.client.query(`INSERT INTO tontine_contribs (tontine_id, round, party_id, status) VALUES ($1,$2,$3,'claimed')`, [t.id, t.round, ctx.party.id])
            await recordPayment(ctx, { payerParty: ctx.party, payeeParty: organiser, amount: t.amount, currency: t.currency, purpose: `Cotisation ${t.name}, tour ${t.round}`, ref: `tontine:${t.id}@${t.round}` })
            return { message: 'Cotisation signalée. L’organisateur doit confirmer.' }
          },
        }
        return {
          review: { lines: [['Groupe', t.name], ['Tour', `${t.round} sur ${t.size}`], ['Cotisation', f(t.amount), true]], cta: `Cotiser ${f(t.amount)}` },
          async exec() {
            const receiver = await creditContribution(ctx.client, t, ctx.party.id, [{ account: await ctx.wallet(), amount: -t.amount, title: `Cotisation ${t.name}`, icon: 'users-round', ref: `tontine:${t.id}` }])
            return { message: receiver ? `Tour complet : ${mask(receiver.name)} reçoit ${f(t.amount * t.size)}` : `Cotisation de ${f(t.amount)} versée` }
          },
        }
      },
    },
    review: {
      label: 'Confirmer les cotisations',
      async form(ctx, row) {
        const { t } = await loadTontine(ctx.client, row, ctx.party)
        if (t.organiser_id !== ctx.user.id) fail('Réservé à l’organisateur', 403)
        const pending = await all(ctx.client, `SELECT r.id, p.name FROM recorded_payments r JOIN parties p ON p.id=r.payer_party WHERE r.ref=$1 AND r.status='claimed'`, [`tontine:${t.id}@${t.round}`])
        if (!pending.length) return { title: 'Confirmer les cotisations', info: 'Aucune cotisation à confirmer.', fields: [], blocked: true }
        return { title: 'Confirmer une cotisation reçue', fields: [{ name: 'payment', label: 'Cotisation reçue de', type: 'select', options: pending.map(p => ({ value: p.id, label: p.name })) }] }
      },
      async run(ctx, input) { await settleRecorded(ctx.client, input.payment, ctx.party, true); return { message: 'Cotisation confirmée' } },
    },
  },
  contributions: async (client, partyId) => (await one(client, `SELECT count(*)::int AS n FROM tontine_contribs WHERE party_id=$1 AND status='confirmed'`, [partyId])).n,
  lateFor: async (client, partyId) => (await one(client, `SELECT count(*)::int AS n FROM tontines t JOIN tontine_members m ON m.tontine_id=t.id
    WHERE m.party_id=$1 AND t.status='active' AND t.next_due < CURRENT_DATE AND NOT EXISTS (SELECT 1 FROM tontine_contribs c WHERE c.tontine_id=t.id AND c.round=t.round AND c.party_id=$1)`, [partyId])).n,
}

export const dueTontines = client => all(client, `SELECT * FROM tontines WHERE status='active' AND next_due <= CURRENT_DATE + 2`)
export { REGIONS as _regions }
