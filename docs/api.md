# HTTP API

All routes are under `/api`, JSON in and out (body limit 20 kB), defined in `server/index.js`, `server/auth.js`, `server/public.js`, `server/uploads.js` and `server/admin.js`. Messages are in French.

Related: [architecture.md](architecture.md#request-lifecycle), [security.md](security.md), [partner-integration.md](partner-integration.md).

## Conventions

**Authentication.** `Authorization: Bearer <accessToken>` (JWT, 15 minutes, `typ: access`, bound to a session row). The refresh token is the httpOnly cookie `nexus_rt` (`Path=/api/auth`, `SameSite=Strict`, 30 days, `Secure` in live). A frozen account may only `GET`.

**Errors.** `{ "error": "<message>" }` with the status code:

| Code | When |
|---|---|
| 400 | Invalid input (`Montant invalide…`, `… : champ requis`), missing `Idempotency-Key`, malformed JSON, insufficient balance (`Solde insuffisant`), limits (`Plafond journalier atteint…`) |
| 401 | Missing/expired/revoked session, wrong OTP or PIN, bad webhook signature |
| 403 | Role required (`Accès réservé`), not your row, frozen account, proposer approving own decision |
| 404 | Unknown route (`Introuvable`), module or action not available for this user, unknown link or row, number without an account |
| 409 | State changed (`Cette action n’est plus possible`), quote expired or used, quote no longer matches, idempotency key reused for other content |
| 422 | Webhook amount or currency mismatch |
| 423 | PIN locked for 15 minutes |
| 429 | Rate limit, OTP caps, lookup cap |
| 500 | Unexpected error: `Une erreur est survenue. Réessayez ; si un débit apparaît par erreur, il sera corrigé.` |

**Idempotency-Key.** Required (else 400) on `POST /api/modules/:id/actions/:action` for direct actions and on `POST /api/intents/:id/confirm`. Scoped per user; the request content is hashed. Same key + same content returns the stored response; same key + other content is 409. Quote requests (actions with a plan) do not read the key: each call creates a new intent. Auth, public, upload, admin and webhook routes do not use it. The client (`src/api.js`) sends a fresh key on every POST and reuses it on retry.

**Rate limits** (per minute, `express-rate-limit`; effectively off when `NEXUS_ENV=test`):

| Scope | Limit | Key |
|---|---|---|
| all `/api` | 300 | IP |
| `/api/auth/*` | 20 | IP |
| `/api/public/*` | 60 | IP |
| `POST /api/modules/:id/actions/:action` | 60 | user |
| `POST /api/intents/:id/confirm` | 20 | user |
| `POST /api/webhooks/provider` | none | — |

`RateLimit-*` headers are sent. Behind a proxy set `TRUST_PROXY`.

## Configuration and health (no auth)

| Method, path | Response |
|---|---|
| `GET /api/health` | `{ ok: true, env }` (runs `SELECT 1`) |
| `GET /api/config/regions` | `{ regions: [{ id, name, currency, dialCode, custody, personas: [{ id, label, tagline, icon, hue, restricted }] }] }` |
| `GET /api/config/sandbox` | Sandbox: `{ pin: '2580', accounts: [{ phone, name, label }] }` (first 30 users). Live: `{ accounts: [] }`. |

## Auth (`/api/auth`, no bearer)

| Method, path | Body | Response |
|---|---|---|
| `POST /otp` | `{ phone }` (must start with `+`) | `{ ok: true, sandboxCode? }`; code only outside live. 429 over daily caps; 502 if the SMS provider refuses the send. |
| `POST /verify` | `{ phone, code }` | Known phone: `{ pinToken, name }` (5 min). New phone: `{ signupToken }` (15 min). |
| `POST /pin` | `{ pinToken, pin }` | `{ accessToken }` + refresh cookie |
| `POST /pin/reset` | `{ pinToken, pin }` (the new PIN) | `{ accessToken, holdHours }` + cookie. Replaces a forgotten PIN, revokes all other sessions; money confirmations answer 423 for `holdHours`. 403 if the account is frozen. |
| `POST /register` | `{ signupToken, name, region, persona, pin }` | `{ accessToken }` + cookie. Phone must start with the region's dial code; persona must exist there; PIN 4–6 digits, not trivial. 409 if the phone has an account. |
| `POST /refresh` | cookie | `{ accessToken }` + rotated cookie; old refresh value is dead. 401 clears the cookie. |
| `POST /logout` | cookie | `{ ok: true }`; session revoked. |

## User API (bearer required)

| Method, path | Body / query | Response |
|---|---|---|
| `GET /api/me` | | `{ user: { id, name, phone, region, persona, kycLevel, pendingRoles, isAdmin }, experience: { region, persona: { id, label, icon, hue, presentation }, nav, services, actions }, unread }` |
| `GET /api/home` | | `{ blocks: [...] }` |
| `GET /api/modules/:id` | | `{ id, label, blocks, actions: [{ id, label, icon }] }` |
| `GET /api/modules/:id/actions/:action` | `?row=<id>` | `{ title, info?, fields: [...], blocked?, needsReview }` |
| `POST /api/modules/:id/actions/:action` | `{ row?, input: { field: value } }` | Money action: `{ review: { lines: [[label, value, strong?]], cta, rate? }, intentId }`. Direct action: `{ done: { message, share?, copy? } }` |
| `POST /api/intents/:id/confirm` | `{ pin }` + `Idempotency-Key` | `{ done: { message, share?, copy? } }` |
| `POST /api/uploads` | raw image body (`image/jpeg`, `png`, `webp`, `heic`; 6 MB), `?lat&lng` | `{ id, meta: { capturedAt, lat?, lng? } }` |
| `GET /api/uploads/:id` | | JPEG, if the caller may see it ([security.md](security.md#uploads)) |

`share` is `{ text, url, whatsapp }` where `whatsapp` is a `https://wa.me/?text=…` link. `copy` is a code to show (order code, cash-out code).

### Form field types

| `type` | Input | Server parsing |
|---|---|---|
| `amount` | decimal text | `toMinor`: digits, optional spaces, one `.` or `,`, at most the currency's decimals; > 0, ≤ 1e12 minor units. Currency: the user's, or `currencyField` (another field holding a region id). |
| `tel` | phone | `normalizePhone`: `00` → `+`; without `+`, user's dial code is prefixed and a leading 0 dropped; `^\+\d{8,15}$` |
| `number` | integer | `min` (default 0) to `max` (default 1e6) |
| `select` | `options: [{ value, label }]` | Value must be one of the options |
| `date` | `YYYY-MM-DD` | Regex only |
| `upload` | photo picker; uploads first, sends the upload id | UUID-shaped string |
| `text` (default) | text | Length ≤ `max` (default 80) |

Common field keys: `name`, `label`, `required` (default true; `false` = optional), `hint`, `placeholder`, `max`, `min`. Undeclared input keys are dropped. A form with `blocked: true` cannot be submitted from the client.

### Blocks

Every block has `type`; module blocks also carry `module`.

| `type` | Fields |
|---|---|
| `balance` | `amount`, `caption`, `sub?` |
| `actions` | `items: [{ id, icon, label, module, action } \| { id, icon, label, opens }]` |
| `insight`, `notice` | `icon`, `text`, `cta?: { label, module, action?, row? }` |
| `kpis` | `title`, `items: [{ label, value, tone? }]` |
| `rows` | `title`, `icon`, `empty?`, `rows: [{ id, title, sub?, value?, status?, tone?, icon?, progress? (0–1), proof? (upload ids), actions?: [{ id, label, tone? }] }]` |
| `feed` | `title`, `empty`, `days: [{ label, items: [{ icon, title, sub, value, positive }] }]` |
| `bars` | `title`, `bars: [{ label, value }]`, `caption`, `total` |
| `budget` | `title`, `left`, `detail`, `pct`, `over`, `cats: [{ label, value }]` |
| `goal` | `title`, `main`, `detail`, `pct`, `reached` |
| `score` | `value`, `note`, `signals: [{ label, pct }]` |
| `zellij` | `filled`, `total`, `level`, `name`, `next`, `perks: [{ label, text, on }]` |
| `note` | `title?`, `text`, `copy?` |

`tone` is `ok`, `wait`, `bad` or empty. A row action opens `GET/POST /api/modules/<block.module>/actions/<id>` with `row = row.id`.

## Public links (`/api/public`, no account)

A link is `PUBLIC_URL/l/<token>`; the PWA route `/l/:token` renders `src/public/PublicPage.jsx`. Kinds: `recorded`, `escrow`, `job`, `order`, `tontine`, `statement`.

| Method, path | Body | Response |
|---|---|---|
| `GET /:token` | | `{ kind, title, lines: [[label, value]], status, actions: [{ id, label, otp, fields, tone }], phone, proof? }`. Names masked; `phone` masked (`+221 •••• 77`) or `null`. 404 if unknown, expired or revoked. |
| `POST /:token/otp` | | Sends a code to the link's party phone: `{ ok, sandboxCode? }`. 400 if the link has no party. |
| `POST /:token/act` | `{ action, code?, input? }` | `{ message }`. The action must be among those the view currently offers (else 404); if `otp` is true, `code` must be valid for the party's phone. `input.phone` is normalized. |
| `POST /:token/upload` | raw image | `{ id, meta }`; job links only. |
| `GET /:token/uploads/:id` | | JPEG, only a photo attached to a stage of that job. |

Actions per kind (OTP column: whether a code is needed):

| Kind | Actions |
|---|---|
| `recorded` | `confirm` (OTP), `reject` (OTP) |
| `escrow` | `pay` (no OTP, phone), `claimPaid` (OTP), `release` (OTP), `dispute` (OTP, reason) |
| `job` | `markDone` (OTP, optional photo), `markReceived` (OTP), `fund` (no OTP, phone), `validate` (OTP), `claimPaid` (OTP), `dispute` (OTP) |
| `order` | `pay` (no OTP, phone), `claimPaid` (no OTP, phone), `confirmReceived` (OTP), `dispute` (OTP) |
| `tontine` | `accept` (OTP), `pay` (no OTP, phone), `claim` (OTP) |
| `statement` | `claimPaid` (OTP, amount) |

## Webhook

`POST /api/webhooks/provider`, raw body (64 kB), header `x-signature: hex(HMAC-SHA256(body, PARTNER_WEBHOOK_SECRET))`. Body `{ id, type, providerRef, amount, currency }`. Responses: `{ ok: true }`, `{ duplicate: true }`, `{ ignored: '<status>' }`; 401 bad signature, 404 unknown `providerRef`, 422 mismatch. Details in [partner-integration.md](partner-integration.md#webhook).

## Admin (`/api/admin`, bearer + active `admin` role, else 403)

| Method, path | Body / query | Effect |
|---|---|---|
| `GET /overview` | | `{ counts: { users, pending_roles, disputes, failed_jobs, adjustments, frozen }, reconciliation: { ok, mismatches }, safeguarding: [{ currency, owed, held_at_partner, ok, owedText, heldText }] }` |
| `GET /funnel?days=30` | | `{ days, users: [{ region, users, new_users, active_7d }], links: [{ region, kind, sent, opened, acted, signed_up, openRate, actRate, signupRate }] }`: accounts per country and, per recipient country and link type, how many invited people opened, acted and signed up. |
| `GET /users` | `?q=` name or phone (ILIKE) | `{ users: [{ id, name, phone, region, persona, kyc_level, frozen, created_at, roles }] }` (50) |
| `GET /users/:id` | | `{ user (no pin_hash), accounts, roles, events }` |
| `POST /users/:id/freeze` | `{ frozen, reason }` | Sets `frozen`; freezing revokes all sessions |
| `POST /users/:id/kyc` | `{ level: 0\|1\|2, reason }` | Sets `kyc_level` |
| `POST /users/:id/roles/:role` | `{ status: 'active'\|'revoked' }` | Upserts the role; cannot change your own admin role; notifies on `agent` |
| `GET /disputes` | | `{ disputes }` (100, open first) |
| `GET /disputes/:id` | | `{ dispute, escrow, payer, payee, stage, evidence }` |
| `POST /disputes/:id/propose` | `{ outcome: 'release'\|'refund'\|'split', note, payeeAmount? }` | `payeeAmount` minor units, 1 to amount − 1, for split |
| `POST /disputes/:id/approve` | | Another admin applies the proposal |
| `GET /adjustments` | | `{ adjustments }` (50) |
| `POST /adjustments` | `{ userId, amount (signed minor units), reason }` | `{ id }`, status `proposed` |
| `POST /adjustments/:id/approve` | | Another admin posts it |
| `GET /outbox` | `?status=failed` (default) | `{ jobs: [{ id, kind, status, attempts, last_error, created_at }] }` (100) |
| `POST /outbox/:id/retry` | | `failed` → `pending`, attempts 0 |
| `GET /audit` | `?who=<actor or object id>&action=<prefix>` | `{ events }` (200) |

Every admin write is in `audit_events` with `actor_type = 'admin'`.

## End-to-end transcript

Captured against `NEXUS_ENV=sandbox PORT=3105 node server/index.js` on the seeded database: Fatou (SN seller) signs in and sends 500 F CFA to Ibrahima. Tokens shortened.

```bash
B=http://localhost:3105/api; J='Content-Type: application/json'

curl -s -X POST $B/auth/otp -H "$J" -d '{"phone":"+221770000001"}'
# {"ok":true,"sandboxCode":"581411"}

curl -s -X POST $B/auth/verify -H "$J" -d '{"phone":"+221770000001","code":"581411"}'
# {"pinToken":"eyJhbGciOiJIUzI1NiIs…","name":"Fatou Diallo"}

curl -s -i -X POST $B/auth/pin -H "$J" -d '{"pinToken":"eyJhbGciOiJIUzI1NiIs…","pin":"2580"}'
# HTTP/1.1 200 OK
# Set-Cookie: nexus_rt=94ce24f8-….ib3FUOXv…; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=2592000
# {"accessToken":"eyJhbGciOiJIUzI1NiIs…"}
A="Authorization: Bearer eyJhbGciOiJIUzI1NiIs…"

curl -s $B/modules/wallet/actions/send -H "$A"
# {"title":"Envoyer de l’argent","fields":[{"name":"amount","label":"Montant","type":"amount"},
#  {"name":"phone","label":"Numéro du destinataire","type":"tel","hint":"Depuis un autre pays, commencez par l'indicatif (+…)."},
#  {"name":"note","label":"Motif (facultatif)","type":"text","required":false}],"needsReview":true}

curl -s -X POST $B/modules/wallet/actions/send -H "$A" -H "$J" \
  -d '{"input":{"amount":"500","phone":"+221770000002","note":"Tissu"}}'
# {"review":{"lines":[["Destinataire","Ibrahima S."],["Montant","500 F CFA"],["Frais","0 F CFA"],
#  ["Total débité","500 F CFA",true]],"cta":"Envoyer 500 F CFA"},"intentId":"62869a42-728e-4df7-a2e3-987f1b25f43e"}

curl -s -X POST $B/intents/62869a42-…/confirm -H "$A" -H "$J" -d '{"pin":"2580"}'
# {"error":"En-tête Idempotency-Key requis"}                                   [400]

K=$(cat /proc/sys/kernel/random/uuid)
curl -s -X POST $B/intents/62869a42-…/confirm -H "$A" -H "$J" -H "Idempotency-Key: $K" -d '{"pin":"1111"}'
# {"error":"Code secret incorrect"}                                            [401]
curl -s -X POST $B/intents/62869a42-…/confirm -H "$A" -H "$J" -H "Idempotency-Key: $K" -d '{"pin":"2580"}'
# {"done":{"message":"500 F CFA envoyés à Ibrahima S."}}                       [200]
curl -s -X POST $B/intents/62869a42-…/confirm -H "$A" -H "$J" -H "Idempotency-Key: $K" -d '{"pin":"2580"}'
# {"done":{"message":"500 F CFA envoyés à Ibrahima S."}}                       [200, replayed]
curl -s -X POST $B/intents/62869a42-…/confirm -H "$A" -H "$J" -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" -d '{"pin":"2580"}'
# {"error":"Ce devis a expiré ou a déjà été utilisé. Recommencez."}           [409]

curl -s $B/home -H "$A"
# {"blocks":[{"type":"balance","amount":"174 500 F CFA","caption":"Solde disponible"}, …
```

The failed PIN attempt counts toward the lockout even though the same key later succeeds: the PIN is checked before the idempotency record.
