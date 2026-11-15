# The catalog: countries and profiles

`server/catalog.js` is the single source of what each user sees. It is plain data, checked at boot by `validateCatalog()` (called from `server/engine.js` when it loads). Country comes first; profiles ("personas") exist inside a country.

Related: [custody-stages.md](custody-stages.md), [architecture.md](architecture.md#server-driven-screens), [api.md](api.md#blocks).

## Top-level tables

| Export | Content |
|---|---|
| `MODULES` | Module id → `{ icon, label, custody? }`. `custody: 'held'` hides the module in `record` countries (`remit`, `float`). Labels may use vocabulary tokens. `home` and `services` are navigation entries, not modules. |
| `ACTIONS` | Quick-action id → `{ icon, label, module, action }` (runs a module action) or `{ icon, label, opens }` (opens a module). |
| `FX_E8_PER_EUR` | Units per 1 EUR × 1e8, as BigInt, per currency. |
| `PRICING` | `remitFee` (minor units, keyed by sender currency: EUR 150, AED 500), `remitFeeByLevel` (`[1, 1, 0.5, 0]`, by reputation level), `agentCommissionBps` (50). |
| `REGIONS` | Country id → region (below). |

## A region

| Field | Example (MA) | Used by |
|---|---|---|
| `name` | `'Maroc'` | Screens, error messages |
| `currency` | `{ code: 'MAD', symbol: 'DH', decimals: 2 }` | All amounts; `CURRENCIES` is built from it |
| `languages` | `['fr', 'ar']` | **Not read anywhere.** |
| `dialCode` | `'+212'` | Local numbers, sign-up check (phone must start with it), `regionOfPhone` |
| `custody` | `'record'` | [custody-stages.md](custody-stages.md) |
| `vocab` | `{ tontine: 'Daret', escrow: 'Aman', reputation: 'Niya' }` | Fills `{tontine}`, `{escrow}`, `{reputation}` in labels and widget titles |
| `modules` | `['wallet', 'tontine', …]` | Modules enabled in the country (union with the persona's `nav`, minus custody-hidden ones) |
| `corridors` | `[]` (FR: `['SN', 'MA', 'GN', 'CI', 'CM']`, AE: `['MA', 'SN']`) | Countries this country may send to (remit, cross-border escrow and jobs) |
| `billers` | `['Lydec', 'Redal', 'ONEE']` | Options of `wallet.bill`; empty list blocks the form |
| `cashAgents` | `true` (SN only) | Enables `wallet.cashCode` |
| `limits` | `{ 0: L(...), 1: L(...), 2: L(...) }` | KYC limits in minor units: `single`, `daily`, `monthly`, `balance` ([money.md](money.md#limits-per-kyc-level)) |
| `personas` | `{ maallem: …, seller: … }` | Profiles offered at sign-up in that country |

## A persona

| Field | Meaning |
|---|---|
| `label`, `tagline`, `icon`, `hue` | Shown at sign-up and in the header; `hue` tints the interface. |
| `nav` | Up to three module ids in the bottom bar (between Accueil and Services). Must be enabled in the region. |
| `actions` | Quick-action ids from `ACTIONS`. The first four that are allowed for this user are shown. |
| `home` | Ordered widgets: `{ type, title, module?, source?, caption? }` (below). |
| `presentation` | `{ contrast: 'high' }` (outdoor profiles: `data-contrast` on the shell) and/or `{ textScale: 1.15 }` (font size). |
| `restricted` | A role name (today only `'agent'`). Signing up with this persona creates the role in `pending`; actions with `role: 'agent'` stay hidden until an admin activates it. |
| `deny` | Optional list of `'module.action'` to hide for this persona. Supported by `engine.js`, used by no persona today. |
| `jobRole` | `'client'` makes `jobs.create` ask for the artisan and the site's country (the builder). Default: the user is the artisan. |

Helpers in the file build personas from shared shapes: `shop()`, `seller()`, `parent`, `artisan()`, `worker`, `abroad()`.

### Home widgets

| `type` | Source | Notes |
|---|---|---|
| `balance` | built in (`balanceBlock`) | `caption` optional. Wallet balance in held, "received this month, confirmed" in record. |
| `actions` | built in | The persona's quick actions. |
| `insight` | built in | Up to three cards: every non-empty `insight()` among enabled modules (a pending confirmation, an invitation, a stage to validate), then the money alerts of `server/insights.js` (cash gap or short runway, best weekday for money received). |
| `trend` | built in | Six months of money received (`server/insights.js`), this month against the same days of last month, plus money out and net. Hidden until something is received. |
| `reputation` | built in | Compact score card (value, level, progress to the next level) that opens the `score` module. Shown only where `score` is enabled. |
| `feed` | built in | Last 8 postings (held) or recorded payments (record). |
| `rows`, `kpis`, `bars`, `budget`, `goal` | `MODS[module].widgets[type]` | Must exist on the module; `source` selects a variant (`family`: `senders` / `beneficiaries`; `remit`: `quote`). Empty `rows` widgets are dropped. |

Widgets per module: `wallet.goal`; `tontine.rows`; `escrow.rows`; `jobs.rows`; `remit.rows`; `family.rows`; `orders.rows`, `orders.kpis`; `creditbook.rows`, `creditbook.kpis`; `invoices.rows`, `invoices.kpis`; `shifts.kpis`, `shifts.bars`; `budget.budget`; `float.kpis`.

## Modules and actions

`P` = money action (`plan`: quote then PIN), `R` = direct action (`run`). `held` = `custody: 'held'`. `row` = acts on a listed item.

| Module | Actions |
|---|---|
| `wallet` | send P held, pay P held, topup P held, withdraw P held, cashCode P held, bill P held, verify R held, goal R, recordIn R, recordOut R, confirmRecorded R row, rejectRecorded R row |
| `escrow` | request R, hold P held, fund P held row, release P row, refund P row, cancel R row, share R row, claimPaid R row, markReceived R row, dispute R row |
| `jobs` | create R, crew R, request R row, fund P held row, done R row, validate P row, claimPaid R row, markReceived R row, dispute R row, share R row |
| `tontine` | create R, accept R row, invite R row, contribute P, review R row |
| `remit` (held) | send P held, schedule R held, unschedule R row |
| `family` | add R, send P held |
| `orders` | create R, share, markPaid, confirmPaid, deliver, complete, refund P, cancel (all row; R unless marked P) |
| `creditbook` | add R, repay R row, remind R row |
| `invoices` | create R, pay P held row, markPaid R row |
| `shifts` | trip R, expense R |
| `budget` | set R, expense R |
| `float` (held) | cashIn P held role agent, cashOut P held role agent |
| `score` | none (view only) |
| `inbox` | readAll R |

## What `validateCatalog` checks

It throws `Catalog invalid:` with one line per problem, and the server does not start.

- Every `ACTIONS` entry points to an existing module (`opens`) or an implemented `module.action`.
- Each region: `custody` is `record` or `held`; `FX_E8_PER_EUR` has its currency; `dialCode` matches `^\+\d{1,4}$`; limits exist for levels 0, 1, 2; every `modules` entry exists in both `MODULES` and the module registry; every corridor is a known region and the region's currency has a `PRICING.remitFee`.
- Each persona: every `nav` module is enabled in the region; every quick action exists; every non-built-in home widget is implemented by its module.

Not checked: vocabulary tokens (an unknown `{token}` renders as the bare word), `presentation` keys, `restricted` role names, `jobRole`, `deny` entries, `billers`, limit values (that single ≤ daily ≤ monthly), duplicate dial codes, that `PRICING` or rates are sensible. There is no versioning: an edit applies to existing users at the next request.

## Add a profile (pure data)

Example: a hairdresser ("Coiffeuse") in Senegal using orders, the credit book and the tontine.

1. In `REGIONS.SN.personas`, add:
   ```js
   coiffeuse: {
     label: 'Coiffeuse', tagline: 'Rendez-vous, acomptes et carnet de crédit.', icon: 'store', hue: 300,
     nav: ['orders', 'creditbook', 'tontine'],
     actions: ['paymentLink', 'addCredit', 'recordIn', 'send'],
     home: [w('balance'), w('actions'), w('kpis', "Aujourd'hui", { module: 'orders' }), w('rows', 'Crédits en cours', { module: 'creditbook' }), w('feed', 'Activité')],
   },
   ```
2. Use only icons present in `src/ui/Icon.jsx` (unknown names render a question-mark icon).
3. Restart. Boot fails with a precise message if anything is wrong. The profile appears at sign-up (`GET /api/config/regions`).
4. Run `npm test`.

No other file changes.

## Add a country (Guinea as the worked example)

`GN` is in the catalog today as a `record` country. This is what it took, and what `held` would take.

**Data (done for GN):**
1. `REGIONS.GN`: `name: 'Guinée'`, `currency: { code: 'GNF', symbol: 'GNF', decimals: 0 }`, `dialCode: '+224'`, `custody: 'record'`, `vocab`, `modules`, `corridors: []`, `billers: []`, `limits` for levels 0–2 in GNF, personas (`commercante`, `artisan`, `ouvrier`, `parent`).
2. `FX_E8_PER_EUR.GNF = 940000000000n` (9 400 GNF per EUR). Without it boot fails.
3. Open the corridor from the sending side: `'GN'` in `REGIONS.FR.corridors`. FR already had `PRICING.remitFee.EUR`. Since Guinea's custody is `record`, a beneficiary in Guinea is paid by mobile-money payout in GNF (the test "scheduled transfers pay once per month" does exactly that).
4. Add GN to the test dial map `DIAL` in `server/test/helpers.js` if tests create Guinean users.

**For `held` custody in Guinea (not done):**
5. A licensed partner in Guinea holding funds (BCRG e-money rules) and its adapter in `server/rails.js` (Orange Money / MTN collections and payouts). There is one adapter for all countries today: per-country routing is **not implemented**.
6. A compliance profile: real `limits` from the partner, KYC flow, screening. Only `limits` exists as configuration; the rest is **not implemented**.
7. `PRICING.remitFee.GNF` if Guinea ever sends abroad (`corridors` non-empty).
8. `billers` and `cashAgents` once integrations exist.
9. `CUSTODY_GN=held` or edit `custody`.

**Code still needed for a real launch:** languages (Pular, Maninka, Susu are oral-first: voice), phone numbering-plan and operator detection (`normalizePhone` is generic), a better amount input for 7–8 digit sums.

## Still hard-coded

| What | Where |
|---|---|
| French strings (labels, messages, errors, notifications) | Everywhere in `server/` and `src/`; no i18n layer |
| `fr-FR` number and date formatting | `fmt`, `formatRate`, `ago`, `longDate` in `server/core.js`; `toLocaleDateString('fr-FR')` in `escrow.js`, `public.js`; weekdays in `work.js` |
| Block types and their rendering | `src/ui/Blocks.jsx`; built-in home widgets in `engine.js` `home()` |
| Module registry | `MODS` in `server/engine.js` |
| Persona-specific paths | `jobRole === 'client'` (`jobs.js`), the `agent` role in `float` (`role: 'agent'`, insight text), region flags `cashAgents` and `billers` (`wallet.js`) |
| Budget categories | `CATEGORIES` in `modules/work.js` |
| Reputation levels, names (zellij), weights, 36 tiles | `LEVELS`, `TILES`, `computeScore` in `modules/work.js` |
| Timers and caps | intent TTL 10 min (`engine.js`), cash code 15 min (`wallet.js`), 40 lookups/day (`context.js`), OTP and PIN rules (`auth.js`), tontine periods 7/30 days (`tontine.js`), 2–30 tontine members, 1–15 crew members, 4 job stages |
| One FX table and pricing for all partners | `FX_E8_PER_EUR`, `PRICING` |
| Sandbox branches | `wallet.js` (`topup` text, `bill`, `verify`), `invoices.pay` info text |
| Test dial codes | `DIAL` in `server/test/helpers.js` |
