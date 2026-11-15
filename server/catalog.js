// Single source of truth for what each user sees: country first, then the profiles that exist in that country.
// Pure data, validated at boot against the module registry. Icons are lucide names; labels may use {vocab} tokens.

export const MODULES = {
  home:       { icon: 'house',           label: 'Accueil' },
  wallet:     { icon: 'wallet',          label: 'Compte' },
  tontine:    { icon: 'users-round',     label: '{tontine}' },
  escrow:     { icon: 'shield-check',    label: '{escrow}' },
  jobs:       { icon: 'hard-hat',        label: 'Chantiers' },
  remit:      { icon: 'globe',           label: 'Envois', custody: 'held' },
  family:     { icon: 'heart-handshake', label: 'Proches' },
  orders:     { icon: 'package',         label: 'Commandes' },
  creditbook: { icon: 'notebook-pen',    label: 'Carnet' },
  invoices:   { icon: 'receipt-text',    label: 'Factures' },
  shifts:     { icon: 'trending-up',     label: 'Gains' },
  budget:     { icon: 'piggy-bank',      label: 'Budget' },
  float:      { icon: 'landmark',        label: 'Float', custody: 'held' },
  score:      { icon: 'gauge',           label: '{reputation}' },
  inbox:      { icon: 'bell',            label: 'Messages' },
  services:   { icon: 'layout-grid',     label: 'Services' },
}

// A quick action either runs a module action (module + action) or opens a module (opens).
export const ACTIONS = {
  send:           { icon: 'arrow-up-right',   label: 'Envoyer',             module: 'wallet', action: 'send' },
  receive:        { icon: 'arrow-down-left',  label: 'Recevoir',            opens: 'wallet' },
  recordIn:       { icon: 'arrow-down-left',  label: 'Paiement reçu',       module: 'wallet', action: 'recordIn' },
  recordOut:      { icon: 'arrow-up-right',   label: 'Paiement fait',       module: 'wallet', action: 'recordOut' },
  scan:           { icon: 'qr-code',          label: 'Payer un code',       module: 'wallet', action: 'pay' },
  withdraw:       { icon: 'banknote',         label: 'Retirer',             module: 'wallet', action: 'withdraw' },
  cashCode:       { icon: 'banknote',         label: 'Retrait chez un agent', module: 'wallet', action: 'cashCode' },
  payBill:        { icon: 'receipt-text',     label: 'Payer une facture',   module: 'wallet', action: 'bill' },
  paymentLink:    { icon: 'link',             label: 'Demande de paiement', module: 'orders', action: 'create' },
  newJob:         { icon: 'plus',             label: 'Nouveau chantier',    module: 'jobs', action: 'create' },
  requestDeposit: { icon: 'shield-check',     label: 'Demander un acompte', module: 'escrow', action: 'request' },
  holdFunds:      { icon: 'shield-check',     label: 'Bloquer des fonds',   module: 'escrow', action: 'hold' },
  validateStage:  { icon: 'badge-check',      label: 'Valider une étape',   opens: 'jobs' },
  addCredit:      { icon: 'notebook-pen',     label: 'Noter un crédit',     module: 'creditbook', action: 'add' },
  paySupplier:    { icon: 'store',            label: 'Facture fournisseur', module: 'invoices', action: 'create' },
  addTrip:        { icon: 'car',              label: 'Course',              module: 'shifts', action: 'trip' },
  addFuel:        { icon: 'fuel',             label: 'Dépense',             module: 'shifts', action: 'expense' },
  addExpense:     { icon: 'minus',            label: 'Dépense',             module: 'budget', action: 'expense' },
  cashIn:         { icon: 'arrow-down-left',  label: 'Dépôt client',        module: 'float', action: 'cashIn' },
  cashOut:        { icon: 'arrow-up-right',   label: 'Retrait client',      module: 'float', action: 'cashOut' },
  sendHome:       { icon: 'globe',            label: 'Envoyer au pays',     module: 'remit', action: 'send' },
  schedule:       { icon: 'calendar-clock',   label: 'Programmer',          module: 'remit', action: 'schedule' },
  addBeneficiary: { icon: 'user-round-plus',  label: 'Ajouter un proche',   module: 'family', action: 'add' },
  contribute:     { icon: 'users-round',      label: 'Cotiser',             module: 'tontine', action: 'contribute' },
  payCrew:        { icon: 'users-round',      label: 'Payer l’équipe',      module: 'jobs', action: 'crew' },
  setGoal:        { icon: 'trending-up',      label: 'Objectif du mois',    module: 'wallet', action: 'goal' },
  newGroup:       { icon: 'users-round',      label: 'Nouveau groupe',      module: 'tontine', action: 'create' },
}

// Rates: units of currency per 1 EUR, scaled by 1e8 so conversions are exact integer arithmetic.
// Sandbox values: in held custody the partner's quote replaces them.
export const FX_E8_PER_EUR = { EUR: 100000000n, MAD: 1085000000n, XOF: 65595700000n, XAF: 65595700000n, AED: 425000000n, GNF: 940000000000n }
// remitFeeByLevel: share of the sending fee charged at each reputation level (0-3). Kept commitments lower the price.
export const PRICING = { remitFee: { EUR: 150, AED: 500 }, remitFeeByLevel: [1, 1, 0.5, 0], agentCommissionBps: 50 }

// KYC levels: 0 = phone verified, 1 = identity verified, 2 = enhanced. Limits in minor units (placeholders until the partner's
// tier rules are signed). single = one outflow, daily/monthly = total outflows, balance = maximum held balance.
const limits = (l0, l1, l2) => ({ 0: l0, 1: l1, 2: l2 })
const L = (single, daily, monthly, balance) => ({ single, daily, monthly, balance })

const w = (type, title, extra = {}) => ({ type, title, ...extra })
const shop = (label, hue = 20) => ({
  label, tagline: 'Commerce de quartier. Carnet de crédit clients et factures fournisseurs.', icon: 'store', hue,
  nav: ['creditbook', 'invoices', 'tontine'],
  actions: ['addCredit', 'recordIn', 'receive', 'paySupplier', 'send'],
  home: [w('balance'), w('actions'), w('insight'), w('trend', 'Encaissements'), w('kpis', 'Carnet de crédit', { module: 'creditbook' }), w('rows', 'Crédits en cours', { module: 'creditbook' }), w('reputation', 'Votre {reputation}'), w('feed', 'Activité')],
})
const seller = tagline => ({
  label: 'Vendeuse en ligne', tagline, icon: 'shopping-bag', hue: 340,
  nav: ['orders', 'escrow', 'tontine'],
  actions: ['paymentLink', 'requestDeposit', 'recordIn', 'send', 'scan'],
  home: [w('balance'), w('actions'), w('insight'), w('kpis', "Aujourd'hui", { module: 'orders' }), w('trend', 'Ventes encaissées'), w('rows', 'À encaisser', { module: 'orders' }), w('reputation', 'Votre {reputation}'), w('feed', 'Activité')],
})
const parent = {
  label: 'Parent au pays', tagline: "Recevez l'argent de vos enfants à l'étranger, simplement.",
  icon: 'heart-handshake', hue: 230, presentation: { textScale: 1.15 },
  nav: ['wallet', 'family'],
  actions: ['cashCode', 'withdraw', 'payBill', 'receive', 'recordIn'],
  home: [w('balance'), w('actions'), w('rows', 'Reçu de vos proches', { module: 'family', source: 'senders' }), w('feed', 'Activité')],
}
// Outdoor profiles get a high-contrast interface with larger controls (presentation.contrast).
const artisan = (label, tagline) => ({
  label, tagline, icon: 'hammer', hue: 60, presentation: { contrast: 'high' },
  nav: ['jobs', 'escrow', 'tontine'],
  actions: ['newJob', 'payCrew', 'requestDeposit', 'recordIn', 'send', 'scan'],
  home: [w('balance'), w('actions'), w('insight'), w('trend', 'Encaissements'), w('rows', 'Chantiers en cours', { module: 'jobs' }), w('rows', 'Acomptes {escrow}', { module: 'escrow' }), w('reputation', 'Votre {reputation}'), w('feed', 'Activité')],
})
const worker = {
  label: 'Ouvrier, journalier', tagline: 'Chantier, atelier ou usine. Chaque paie confirmée construit votre dossier, sans banque.',
  icon: 'hard-hat', hue: 100, presentation: { contrast: 'high' },
  nav: ['wallet', 'tontine', 'score'],
  actions: ['recordIn', 'setGoal', 'contribute', 'send'],
  home: [w('balance'), w('actions'), w('goal', 'Objectif du mois', { module: 'wallet' }), w('insight'), w('trend', 'Paies reçues'), w('reputation', 'Votre {reputation}'), w('feed', 'Paies et paiements')],
}
const abroad = (label, tagline, icon, hue, last) => ({
  label, tagline, icon, hue,
  nav: ['remit', 'family', 'tontine'],
  actions: ['sendHome', 'schedule', last, 'send'],
  home: [w('balance'), w('actions'), w('rows', 'Taux du jour', { module: 'remit', source: 'quote' }), w('rows', 'Vos proches', { module: 'family', source: 'beneficiaries' }), w('feed', 'Activité')],
})

// custody: "record" = stage 1, no money moves through Nexus (parties pay each other directly; Nexus records and confirms).
// "held" = stage 2, a licensed partner holds funds and Nexus keeps a shadow ledger. Override per country with CUSTODY_<ID>.
export const REGIONS = {
  MA: {
    name: 'Maroc', currency: { code: 'MAD', symbol: 'DH', decimals: 2 }, languages: ['fr', 'ar'], dialCode: '+212', custody: 'record',
    vocab: { tontine: 'Daret', escrow: 'Aman', reputation: 'Niya' },
    modules: ['wallet', 'tontine', 'escrow', 'jobs', 'orders', 'creditbook', 'invoices', 'family', 'score', 'inbox'],
    corridors: [], billers: ['Lydec', 'Redal', 'ONEE'],
    limits: limits(L(200000, 500000, 2000000, 500000), L(1000000, 2000000, 10000000, 2000000), L(5000000, 10000000, 50000000, 20000000)),
    personas: {
      maallem: artisan('Maâllem', 'Artisan du bâtiment. Faites valider chaque étape et gardez la preuve de chaque paiement.'),
      seller: seller('Instagram et WhatsApp. Faites payer avant la livraison.'),
      ouvrier: worker,
      hanout: shop('Moul hanout'),
      parent,
    },
  },
  SN: {
    name: 'Sénégal', currency: { code: 'XOF', symbol: 'F CFA', decimals: 0 }, languages: ['fr', 'wo'], dialCode: '+221', custody: 'held',
    vocab: { tontine: 'Natt', escrow: 'Séquestre', reputation: 'Réputation' },
    modules: ['wallet', 'tontine', 'orders', 'shifts', 'float', 'creditbook', 'invoices', 'family', 'escrow', 'score', 'inbox'],
    corridors: [], billers: ['Senelec', "Sen'Eau"], cashAgents: true,
    limits: limits(L(200000, 500000, 2000000, 2000000), L(1000000, 2000000, 15000000, 4000000), L(5000000, 10000000, 50000000, 20000000)),
    personas: {
      seller: seller('WhatsApp et TikTok. Faites payer avant de livrer.'),
      driver: {
        label: 'Chauffeur', tagline: 'Taxi, VTC ou moto Jakarta. Voyez ce qui reste après le carburant.', icon: 'car', hue: 255,
        nav: ['shifts', 'tontine', 'wallet'],
        actions: ['addTrip', 'addFuel', 'send', 'scan'],
        home: [w('balance'), w('actions'), w('insight'), w('kpis', "Aujourd'hui", { module: 'shifts' }), w('bars', 'Cette semaine', { module: 'shifts' }), w('feed', 'Activité')],
      },
      agent: {
        label: 'Agent mobile money', tagline: 'Point de service agréé. Pilotez votre float et vos commissions.', icon: 'landmark', hue: 45,
        restricted: 'agent',
        nav: ['float', 'wallet', 'score'],
        actions: ['cashIn', 'cashOut', 'send'],
        home: [w('balance', null, { caption: 'Float disponible' }), w('actions'), w('kpis', "Aujourd'hui", { module: 'float' }), w('insight'), w('feed', 'Dernières opérations')],
      },
      boutique: shop('Boutiquier'),
      parent,
    },
  },
  GN: {
    name: 'Guinée', currency: { code: 'GNF', symbol: 'GNF', decimals: 0 }, languages: ['fr'], dialCode: '+224', custody: 'record',
    vocab: { tontine: 'Tontine', escrow: 'Séquestre', reputation: 'Réputation' },
    modules: ['wallet', 'tontine', 'escrow', 'jobs', 'orders', 'creditbook', 'invoices', 'family', 'score', 'inbox'],
    corridors: [], billers: [],
    limits: limits(L(5000000, 10000000, 40000000, 10000000), L(20000000, 40000000, 200000000, 50000000), L(100000000, 200000000, 1000000000, 300000000)),
    personas: {
      commercante: { ...shop('Commerçante du marché', 20), tagline: 'Marché Madina ou quartier. Carnet de crédit, tontine et preuves de paiement.' },
      artisan: artisan('Maçon, artisan', 'Construction pour la diaspora. Faites valider chaque étape, preuve à l’appui.'),
      ouvrier: worker,
      parent,
    },
  },
  CI: {
    name: 'Côte d’Ivoire', currency: { code: 'XOF', symbol: 'F CFA', decimals: 0 }, languages: ['fr'], dialCode: '+225', custody: 'record',
    vocab: { tontine: 'Tontine', escrow: 'Séquestre', reputation: 'Réputation' },
    modules: ['wallet', 'tontine', 'escrow', 'jobs', 'orders', 'creditbook', 'invoices', 'family', 'score', 'inbox'],
    corridors: [], billers: ['CIE', 'SODECI'],
    limits: limits(L(200000, 500000, 2000000, 2000000), L(1000000, 2000000, 15000000, 4000000), L(5000000, 10000000, 50000000, 20000000)),
    personas: {
      seller: seller('WhatsApp, TikTok et Facebook. Faites payer avant de livrer.'),
      commercante: { ...shop('Commerçante du marché', 20), tagline: 'Adjamé, Treichville ou quartier. Carnet de crédit, tontine et preuves de paiement.' },
      artisan: artisan('Artisan du bâtiment', 'Chantiers à Abidjan et pour la diaspora. Faites valider chaque étape, preuve à l’appui.'),
      ouvrier: worker,
      parent,
    },
  },
  CM: {
    name: 'Cameroun', currency: { code: 'XAF', symbol: 'F CFA', decimals: 0 }, languages: ['fr', 'en'], dialCode: '+237', custody: 'record',
    vocab: { tontine: 'Njangi', escrow: 'Séquestre', reputation: 'Réputation' },
    modules: ['wallet', 'tontine', 'escrow', 'jobs', 'orders', 'creditbook', 'invoices', 'family', 'score', 'inbox'],
    corridors: [], billers: ['ENEO', 'Camwater'],
    limits: limits(L(200000, 500000, 2000000, 2000000), L(1000000, 2000000, 15000000, 4000000), L(5000000, 10000000, 50000000, 20000000)),
    personas: {
      seller: seller('WhatsApp et Facebook. Faites payer avant de livrer.'),
      boutique: shop('Boutiquier'),
      artisan: artisan('Artisan du bâtiment', 'Chantiers à Douala et Yaoundé. Faites valider chaque étape, preuve à l’appui.'),
      ouvrier: worker,
      parent,
    },
  },
  FR: {
    name: 'France', currency: { code: 'EUR', symbol: '€', decimals: 2 }, languages: ['fr'], dialCode: '+33', custody: 'held',
    vocab: { tontine: 'Tontine', escrow: 'Séquestre', reputation: 'Réputation' },
    modules: ['wallet', 'remit', 'tontine', 'budget', 'family', 'jobs', 'escrow', 'score', 'inbox'],
    corridors: ['SN', 'MA', 'GN', 'CI', 'CM'], billers: [],
    limits: limits(L(15000, 15000, 15000, 15000), L(500000, 1000000, 1500000, 1500000), L(5000000, 5000000, 10000000, 10000000)),
    personas: {
      student: {
        label: 'Étudiant·e', tagline: "Budget serré. Recevez l'aide de la famille et tenez le mois.", icon: 'graduation-cap', hue: 155,
        nav: ['budget', 'tontine', 'wallet'],
        actions: ['receive', 'send', 'addExpense', 'scan'],
        home: [w('balance'), w('actions'), w('budget', 'Budget du mois', { module: 'budget' }), w('rows', 'Aide de la famille', { module: 'family', source: 'senders' }), w('feed', 'Activité')],
      },
      sender: abroad('Soutien de famille', 'Envoyez au pays chaque mois, avec le montant reçu affiché avant de payer.', 'send', 195, 'addBeneficiary'),
      builder: {
        label: 'Projet au pays', tagline: "Construisez à distance. L'artisan est payé étape par étape, sur preuve.", icon: 'building-2', hue: 85,
        nav: ['jobs', 'escrow', 'remit'], jobRole: 'client',
        actions: ['newJob', 'validateStage', 'holdFunds', 'sendHome'],
        home: [w('balance'), w('actions'), w('insight'), w('rows', 'Votre chantier', { module: 'jobs' }), w('rows', 'Fonds en {escrow}', { module: 'escrow' }), w('rows', 'Taux du jour', { module: 'remit', source: 'quote' })],
      },
    },
  },
  AE: {
    name: 'Émirats', currency: { code: 'AED', symbol: 'AED', decimals: 2 }, languages: ['fr', 'ar', 'en'], dialCode: '+971', custody: 'held',
    vocab: { tontine: 'Tontine', escrow: 'Séquestre', reputation: 'Réputation' },
    modules: ['wallet', 'remit', 'family', 'tontine', 'escrow', 'invoices', 'score', 'inbox'],
    corridors: ['MA', 'SN'], billers: [],
    limits: limits(L(300000, 300000, 300000, 300000), L(3500000, 3500000, 10000000, 3500000), L(20000000, 20000000, 50000000, 20000000)),
    personas: {
      worker: abroad('Travailleur expatrié', 'Salaire aux Émirats. Envoyez au pays dès le jour de paie.', 'briefcase', 205, 'contribute'),
      trader: {
        label: 'Commerçant import', tagline: 'Achats à Dubaï. Suivez chaque facture fournisseur et sécurisez le fret.', icon: 'ship', hue: 30,
        nav: ['invoices', 'escrow', 'remit'],
        actions: ['paySupplier', 'holdFunds', 'sendHome', 'scan'],
        home: [w('balance'), w('actions'), w('insight'), w('kpis', 'Factures', { module: 'invoices' }), w('trend', 'Entrées'), w('rows', 'À régler', { module: 'invoices' }), w('feed', 'Activité')],
      },
    },
  },
}

for (const [id, r] of Object.entries(REGIONS)) {
  const override = process.env[`CUSTODY_${id}`]
  if (override) r.custody = override
}

// SIGNUP_REGIONS=MA,GN opens sign-up in those countries only (a pilot). Unset: every country is open.
// Accounts that already exist elsewhere keep working; closed countries are simply not offered.
const open = process.env.SIGNUP_REGIONS?.split(',').map(s => s.trim()).filter(Boolean)
for (const id of open ?? []) if (!REGIONS[id]) throw new Error(`SIGNUP_REGIONS: unknown country "${id}"`)
export const regionOpen = id => Boolean(REGIONS[id]) && (!open || open.includes(id))
export const openRegionIds = () => Object.keys(REGIONS).filter(regionOpen)

export const CURRENCIES = Object.fromEntries(Object.values(REGIONS).map(r => [r.currency.code, r.currency]))
export const fill = (text, vocab) => text?.replace(/\{(\w+)\}/g, (_, k) => vocab[k] ?? k)
export const regionOfCurrency = code => Object.keys(REGIONS).find(id => REGIONS[id].currency.code === code)

// Throws at boot if the catalog refers to anything that does not exist, so a typo is never a runtime 500.
export function validateCatalog(mods) {
  const errors = []
  const check = (ok, msg) => { if (!ok) errors.push(msg) }
  for (const [aid, a] of Object.entries(ACTIONS)) {
    if (a.opens) check(MODULES[a.opens], `action ${aid}: unknown module ${a.opens}`)
    else check(mods[a.module]?.actions[a.action], `action ${aid}: ${a.module}.${a.action} not implemented`)
  }
  for (const [rid, r] of Object.entries(REGIONS)) {
    check(['record', 'held'].includes(r.custody), `${rid}: custody must be record or held`)
    check(FX_E8_PER_EUR[r.currency.code], `${rid}: no FX rate for ${r.currency.code}`)
    check(/^\+\d{1,4}$/.test(r.dialCode), `${rid}: bad dial code`)
    for (const lvl of [0, 1, 2]) check(r.limits?.[lvl], `${rid}: missing limits for KYC level ${lvl}`)
    for (const m of r.modules) check(mods[m] && MODULES[m], `${rid}: unknown module ${m}`)
    for (const c of r.corridors) {
      check(REGIONS[c], `${rid}: unknown corridor ${c}`)
      check(PRICING.remitFee[r.currency.code] !== undefined, `${rid}: corridor ${c} needs a remit fee for ${r.currency.code}`)
    }
    for (const [pid, p] of Object.entries(r.personas)) {
      for (const m of p.nav) check(r.modules.includes(m), `${rid}.${pid}: nav module ${m} not enabled in region`)
      for (const a of p.actions) check(ACTIONS[a], `${rid}.${pid}: unknown action ${a}`)
      for (const wd of p.home) {
        if (['balance', 'actions', 'insight', 'feed', 'trend', 'reputation'].includes(wd.type)) continue
        check(mods[wd.module]?.widgets?.[wd.type], `${rid}.${pid}: widget ${wd.module}.${wd.type} not implemented`)
      }
    }
  }
  if (errors.length) throw new Error(`Catalog invalid:\n- ${errors.join('\n- ')}`)
}

export function listRegions() {
  return Object.entries(REGIONS).filter(([id]) => regionOpen(id)).map(([id, r]) => ({
    id, name: r.name, currency: r.currency, dialCode: r.dialCode, custody: r.custody,
    personas: Object.entries(r.personas).map(([pid, p]) => ({ id: pid, label: p.label, tagline: p.tagline, icon: p.icon, hue: p.hue, restricted: Boolean(p.restricted) })),
  }))
}

export const personaExists = (regionId, personaId) => regionOpen(regionId) && Boolean(REGIONS[regionId].personas[personaId])

// What a user may see: modules hidden when their custody stage does not support them.
export function moduleAvailable(region, modId) {
  const m = MODULES[modId]
  return Boolean(m) && (m.custody !== 'held' || region.custody === 'held')
}
