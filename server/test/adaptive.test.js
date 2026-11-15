// The adaptive OS: regions and profiles created, closed and changed at runtime, and profile drift.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool, one, all, resetDb, user, act, engine, partyOf } from './helpers.js'

const runtime = await import('../catalog-runtime.js')
const { REGIONS, listRegions, personaExists, CURRENCIES } = await import('../catalog.js')

before(async () => { await resetDb(); runtime.resetCatalog() })
after(async () => { runtime.resetCatalog(); await pool.end() })

const activate = async (overlay, note, a, b) => {
  const id = await runtime.proposeVersion({ overlay, note, adminId: a.id })
  await runtime.approveVersion(id, b.id)
  return id
}

test('a new region and profile go live at runtime, validated, with two admins', async () => {
  const a1 = await user('FR', 'sender', { roles: ['admin'] }), a2 = await user('FR', 'sender', { roles: ['admin'] })
  const togo = { ...JSON.parse(JSON.stringify(REGIONS.CI)), name: 'Togo', dialCode: '+228', corridors: [], billers: ['CEET'] }
  togo.personas = { seller: { ...togo.personas.seller, tagline: 'Lomé : faites payer avant de livrer.' } }
  const dangling = await runtime.overlayErrors({ regions: { TG: togo } })
  assert.ok(dangling.some(e => /drift target boutique_pro/.test(e)), 'a drift rule must point to a profile of the same region')
  togo.personas.seller.drift = []

  const broken = await runtime.overlayErrors({ regions: { TG: { ...togo, modules: ['wallet', 'teleport'] } } })
  assert.ok(broken.some(e => /unknown module teleport/.test(e)), 'an unknown module is refused before anything goes live')

  const id = await runtime.proposeVersion({ overlay: { regions: { TG: togo } }, note: 'Ouverture du Togo', adminId: a1.id })
  await assert.rejects(runtime.approveVersion(id, a1.id), /autre personne/, 'the proposer cannot approve')
  assert.equal(REGIONS.TG, undefined, 'nothing changes before approval')
  await runtime.approveVersion(id, a2.id)

  assert.equal(REGIONS.TG.name, 'Togo')
  assert.ok(listRegions().some(r => r.id === 'TG'), 'offered at sign-up')
  assert.equal(CURRENCIES.XOF.symbol, 'F CFA')
  const seller = await user('TG', 'seller')
  const me = await engine.me(seller.id)
  assert.equal(me.experience.region.name, 'Togo')
  assert.ok(me.experience.actions.length > 0)
})

test('closing a profile stops sign-ups but never breaks existing accounts; deleting one in use is refused', async () => {
  const a1 = await user('FR', 'sender', { roles: ['admin'] }), a2 = await user('FR', 'sender', { roles: ['admin'] })
  const parent = await user('MA', 'parent')
  const base = (await runtime.catalogState()).active.overlay // the Togo version from the previous test
  assert.ok((await runtime.overlayErrors({})).some(e => e.includes('compte(s) en TG')), 'a rollback cannot remove a region that now has accounts')
  await activate({ ...base, closed: ['MA.parent'] }, 'Profil parent fermé au pilote', a1, a2)
  assert.equal(personaExists('MA', 'parent'), false)
  assert.ok(!listRegions().find(r => r.id === 'MA').personas.some(p => p.id === 'parent'))
  assert.ok((await engine.home(parent.id)).blocks.length > 0, 'an existing parent account keeps working')

  const errors = await runtime.overlayErrors({ regions: { MA: { personas: { parent: null } } } })
  assert.ok(errors.some(e => /fermez le profil/.test(e)), 'a profile with accounts can be closed, not deleted')

  // Rollback = an earlier overlay proposed again.
  await activate(base, 'Réouverture du profil parent', a1, a2)
  assert.equal(personaExists('MA', 'parent'), true)
  runtime.resetCatalog()
})

test('drift: a maâllem paying five workers is offered the Entreprise profile, switches with consent, keeps everything', async () => {
  const boss = await user('MA', 'maallem')
  const crew = []
  for (let i = 0; i < 5; i++) crew.push(await user('MA', 'ouvrier'))
  await act(boss, 'jobs', 'crew', { amount: '250', phones: crew.map(c => c.phone).join(', '), purpose: 'Semaine 46' })
  assert.equal((await engine.home(boss.id)).blocks.some(b => /Entreprise du bâtiment/.test(b.text ?? '')), false, 'unconfirmed pay is not a signal')
  const bp = await partyOf(boss)
  for (const w of crew) {
    const rp = await one(pool, `SELECT r.id FROM recorded_payments r JOIN parties p ON p.id=r.payee_party WHERE r.payer_party=$1 AND p.user_id=$2`, [bp.id, w.id])
    await act(w, 'wallet', 'confirmRecorded', {}, rp.id)
  }
  const home = await engine.home(boss.id)
  assert.ok(home.blocks.some(b => b.type === 'insight' && /5 ouvriers différents/.test(b.text) && /Entreprise du bâtiment/.test(b.text)))

  const { ctxFor } = await import('../context.js')
  const { personaChoices, switchPersona } = await import('../drift.js')
  const choices = await personaChoices(await ctxFor(pool, boss.id))
  assert.equal(choices.suggestion.to, 'entreprise')
  assert.ok(choices.choices.find(c => c.id === 'entreprise').suggested)
  assert.ok(!choices.choices.some(c => c.id === 'maallem'), 'not the current profile')

  const { tx } = await import('../db.js')
  const done = await tx(async c => switchPersona(await ctxFor(c, boss.id), 'entreprise'))
  assert.equal(done.reason, 'drift')
  const me = await engine.me(boss.id)
  assert.equal(me.experience.persona.label, 'Entreprise du bâtiment')
  assert.equal((await all(pool, `SELECT 1 FROM recorded_payments WHERE payer_party=$1 AND status='confirmed'`, [bp.id])).length, 5, 'records kept')
  await assert.rejects(tx(async c => switchPersona(await ctxFor(c, boss.id), 'maallem')), /tous les 30 jours/, 'cooldown')
})
