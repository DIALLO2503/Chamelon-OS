# Nexus

Nexus is a money engine for the informal economy.
One double-entry ledger and a set of reusable modules (record, hold, release, collect, send, save together) are configured per **country** and per **profile** in `server/catalog.js`.
A Moroccan artisan, a Dakar online seller, a Guinean market trader and a Paris engineer building a house back home each get their own app, built from the same parts.
The people they deal with (clients, buyers, tontine members, family) never install anything: they act from a WhatsApp link.
Each country runs in a custody stage: `record` (no money passes through Nexus) or `held` (a licensed partner holds the funds; Nexus keeps a shadow ledger).

## Status

Sandbox only. No licence and no payment partner are signed. Everything external is simulated:

| Piece | In sandbox | Where the live version plugs in |
|---|---|---|
| Payment partner (collections, payouts, custody) | Simulated; settles by signed webhook about 0.4 s later | `server/rails.js` (`partnerProvider`) |
| Login codes (SMS) | Returned to the client and shown on screen | `server/messaging.js`, called by `issueOtp`: an Android phone gateway or Twilio; tested against stand-ins, not yet against a real phone or account |
| WhatsApp/SMS notifications | Written to the log; the in-app inbox works | `server/messaging.js` (Twilio), called by the outbox: same status; WhatsApp templates still need Meta approval |
| Identity checks | One tap (`wallet.verify`), or an admin sets the level | Partner or KYC vendor writing `users.kyc_level` |
| FX rates and fees | Static values in `server/catalog.js` | Partner quotes |
| Bill payment | Simulated payout | Biller integrations |

See [docs/partner-integration.md](docs/partner-integration.md) for the full list.

## Quick start

Requires **Node 20.9+** (sharp needs it; tested on Node 22) and **PostgreSQL 14+** (tested on 16).

```bash
# 1. Database: one role, two databases (the app and the test suite)
sudo -u postgres psql -c "CREATE ROLE nexus LOGIN PASSWORD 'nexus'"
sudo -u postgres createdb -O nexus nexus
sudo -u postgres createdb -O nexus nexus_test

# 2. Install, seed, build, run
npm install
npm run seed                     # migrates, then creates 19 demo accounts (PIN 2580); does nothing if users exist
npm run build                    # builds the PWA into dist/
npm run server                   # http://localhost:3001 (serves dist/ and /api)

# 3. Tests (59, end to end, against nexus_test; the schema is dropped and recreated)
npm test
```

With the default URLs (`postgres://nexus:nexus@localhost:5432/nexus` in sandbox, `.../nexus_test` in test) no `DATABASE_URL` is needed.
Migrations in `server/migrations/` run automatically at server start and at seed time.

**Dev mode.** Run `npm run server` in one terminal and `npm run dev` in another. Vite serves the interface with hot reload on its own port (5173 by default) and proxies `/api` to `http://localhost:3001` (`vite.config.js`).

**Windows.** `npm run server` and `npm run seed` work as is: they load `NEXUS_ENV=sandbox` from `env/sandbox.env` with `node --env-file`. A variable already set in the shell wins over the file.

**First admin.** `NEXUS_ENV=sandbox npm run admin:create -- +33600000099` (PowerShell: `$env:NEXUS_ENV="sandbox"; npm run admin:create -- +33600000099`) grants the admin role to an existing account (sign up in the app first). `NEXUS_ENV` must be set explicitly here, so the command never defaults to sandbox against a live database.

`npm start` builds and then runs `node server/index.js`; it needs `NEXUS_ENV` in the environment.

## Demo accounts

All use PIN `2580`. In sandbox the sign-in screen lists them (`GET /api/config/sandbox`) and shows the login code.

| Phone | Name | Country · profile | Custody |
|---|---|---|---|
| +33600000099, +33600000098 | Admin Nexus, Admin Contrôle | Admins (two, for the two-person rule) | — |
| +212600000001 | Hassan Benali | MA · maâllem | record |
| +212600000005 | Youssef El Amrani | MA · ouvrier | record |
| +212600000002 | Salma Tazi | MA · seller | record |
| +212600000003 | Brahim Ouazzani | MA · moul hanout | record |
| +212600000004 | Khadija Bennani | MA · parent | record |
| +221770000001 | Fatou Diallo | SN · seller | held |
| +221770000002 | Ibrahima Sow | SN · driver | held |
| +221770000003 | Aïssatou Ba | SN · agent (approved) | held |
| +221770000004 | Modou Fall | SN · boutique | held |
| +221770000005 | Mame Diarra Ndiaye | SN · parent | held |
| +224620000001 | Mariama Camara | GN · commerçante | record |
| +224620000002 | Sékou Condé | GN · artisan | record |
| +33600000001 | Aminata Sow | FR · student | held |
| +33600000002 | Ousmane Diallo | FR · sender | held |
| +33600000003 | Karim Bennani | FR · builder | held |
| +971500000001 | Abdoulaye Kane | AE · worker | held |
| +971500000002 | Samir Khalil | AE · trader | held |

## Configuration

All variables are read in `server/config.js` (plus `CUSTODY_<ID>` in `server/catalog.js`).

| Variable | Default | Meaning |
|---|---|---|
| `NEXUS_ENV` | none: boot fails | `sandbox`, `test` or `live`. Anything else refuses to start. |
| `PORT` | `3001` | HTTP port. |
| `DATABASE_URL` | local `nexus` (sandbox) / `nexus_test` (test) | Required in live. |
| `JWT_SECRET`, `LINK_SECRET` | generated into `.local/` outside live | Session/OTP signing; public-link and cash-code hashing. Required in live. |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Base of links sent by WhatsApp (`/l/<token>`). |
| `TRUST_PROXY` | `0` | Number of proxy hops, so rate limits see real client IPs. |
| `UPLOAD_DIR` | `.local/uploads` | Where re-encoded photos are written. |
| `PAYMENT_PROVIDER` | `sandbox` (`partner` in live) | Live accepts `partner`, or `none` when every country open to sign-up is in `record` custody. |
| `SIGNUP_REGIONS` | all countries | Comma-separated country ids (`MA,GN`) where sign-up is offered. Existing accounts elsewhere keep working. |
| `PARTNER_BASE_URL`, `PARTNER_API_KEY`, `PARTNER_WEBHOOK_SECRET` | webhook secret `sandbox-webhook-secret` outside live | Partner API and webhook HMAC secret. All three required in live. |
| `SMS_PROVIDER` | none | `smsgate` (Android phones as SMS gateways) or `twilio`. Required in live. |
| `SMSGATE_<ID>_USER`, `SMSGATE_<ID>_PASSWORD`, `SMSGATE_USER`, `SMSGATE_PASSWORD` | none | With `smsgate`: the credentials of the phone that sends for country `<ID>`, and optionally of a default phone for every other number. `SMSGATE_BASE_URL` overrides the relay; `SMSGATE_<ID>_URL` points one country at a phone reachable directly (the app's local mode). |
| `SMS_API_KEY`, `TWILIO_ACCOUNT_SID` | none | With `twilio`: `SMS_API_KEY` is the auth token. When set outside live, login codes are sent by SMS as well as shown on screen. |
| `SMS_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | none | SMS sender: a number or alphanumeric ID, or a messaging service that picks the sender per country. One is required with `SMS_PROVIDER`. |
| `NOTIFIER` | `log` (in live: `whatsapp` with Twilio, else `sms`) | `log` writes messages to the log (refused in live). `sms` sends every message by SMS. `whatsapp` sends approved templates on WhatsApp and the rest by SMS. |
| `WHATSAPP_FROM`, `WHATSAPP_TEMPLATES` | none | WhatsApp sender number (required with `NOTIFIER=whatsapp`) and a JSON object mapping notification template names to Twilio Content SIDs. |
| `TWILIO_BASE_URL` | `https://api.twilio.com` | Override for tests. |
| `PIN_RESET_HOLD_HOURS` | `24` | How long money actions wait after a forgotten secret code is replaced. |
| `AUTO_RELEASE_DAYS` | `7` | Silence-means-yes delay for a finished job stage. |
| `ORDER_RELEASE_HOURS` | `72` | Silence-means-yes delay for a delivered protected order. |
| `CUSTODY_MA`, `CUSTODY_SN`, `CUSTODY_GN`, `CUSTODY_FR`, `CUSTODY_AE` | catalog value | Override a country's custody stage (`record` or `held`). |
| `NEXUS_NO_AUTO_SETTLE`, `SANDBOX_AUTO_SETTLE` | unset | Sandbox/test only: stop, or (in test) start, the simulated partner webhook. |

## Documentation

| Document | For |
|---|---|
| [docs/architecture.md](docs/architecture.md) | The system in one diagram, request lifecycle, design decisions and the audit findings they answer |
| [docs/money.md](docs/money.md) | Ledger, accounts, limits, FX, every money flow with postings, reconciliation and coverage |
| [docs/custody-stages.md](docs/custody-stages.md) | `record` vs `held`, state machines, switching a country |
| [docs/catalog.md](docs/catalog.md) | Countries, profiles, modules, adding a profile or a country |
| [docs/api.md](docs/api.md) | Every endpoint, block and field types, a real curl transcript |
| [docs/security.md](docs/security.md) | Threat model, controls, data protection, known gaps |
| [docs/operations.md](docs/operations.md) | Running a pilot, scheduler, runbooks |
| [docs/partner-integration.md](docs/partner-integration.md) | Go-live checklist for a licensed partner |
| [docs/pilot.md](docs/pilot.md) | Running the two-country pilot on one server, with phones as SMS gateways and no payment partner |
| [docs/demo.md](docs/demo.md) | A public sandbox demo on Render in a few clicks (`render.yaml`), with the demo accounts |
| [docs/testing.md](docs/testing.md) | What the 59 tests prove and how to add one |
| [docs/glossary.md](docs/glossary.md) | Product and domain terms |

## Layout

```
server/
  index.js        Express app, routes, rate limits, error handler; boots migrations, outbox worker, scheduler
  config.js       environment, fail-closed checks          db.js        pool, transactions, compare-and-set, migrations
  catalog.js      countries, profiles, modules, limits      engine.js    forms, quotes (intents), PIN confirm, idempotency
  ledger.js       double-entry postings, limits, reconcile  rails.js     outbox, provider adapter, webhook, notify, links
  auth.js         OTP, PIN, sessions                        public.js    link pages for people without the app
  uploads.js      photo re-encoding and access              admin.js     back office, two-person rule, coverage check
  scheduler.js    periodic jobs under an advisory lock      seed.js      sandbox demo data
  modules/        wallet, escrow, jobs, tontine, remit/family, commerce, work (shifts, budget, float, score), inbox
src/              React PWA: server-driven screens, action sheet, PIN pad, public link page, admin console
```

## Known limits

- French only; amounts and dates formatted `fr-FR`. No Darija, Wolof, Arabic, RTL or voice.
- Live mode boots, but login codes and WhatsApp messages are not sent: there is no SMS or WhatsApp integration yet.
- The coverage check compares Nexus's own accounts with each other, not with a partner statement (see [docs/money.md](docs/money.md)).
- No CI, no backups, no metrics or error tracking, no data export or erasure.
- Offline: only the app shell is cached; data is not.
- Reputation lowers sending fees by level; it unlocks no credit.
- Behaviour gaps found while documenting are listed in [docs/security.md](docs/security.md#known-gaps-and-non-goals).
