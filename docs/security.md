# Security and data protection

Related: [api.md](api.md), [architecture.md](architecture.md#design-decisions), [operations.md](operations.md).

## Threat model

| Actor | Wants to | Main controls |
|---|---|---|
| Stranger on the internet | Take over an account, mint money, scrape phones and names | Fail-closed env, OTP caps, PIN, masked names, lookup cap, rate limits |
| Thief with an unlocked phone | Spend the balance | PIN on every money action, 5-try lockout, 24-hour money hold after a PIN reset, session revocation by freeze |
| Malicious user | Pay twice, overdraw, replay, act on others' rows | Quotes bound by hash, idempotency, compare-and-set, row checks, DB floors |
| Self-declared agent and accomplice | Earn commission on fake cash loops | Agent role approved by admin, customer-created cash-out code, round trips withheld |
| Holder of someone else's link | Act for the counterparty | Viewing only with the link; committing actions need a code sent to the party's phone |
| Forged partner | Credit money by fake webhooks | HMAC signature, event dedupe, amount and currency check |
| Insider admin | Move money alone | Two-person rule on disputes and adjustments, audit log |
| Operator mistake | Run sandbox in production, break the catalog | `NEXUS_ENV` required, live checks, `validateCatalog` |

## Environments and fail-closed boot (`server/config.js`)

- `NEXUS_ENV` must be `sandbox`, `test` or `live`; otherwise the process throws at import.
- `config.sandbox` is true for anything but `live`.
- In `live`: `JWT_SECRET`, `LINK_SECRET`, `DATABASE_URL` are required (no generated secrets); `PAYMENT_PROVIDER` must be `partner` with `PARTNER_BASE_URL`, `PARTNER_API_KEY`, `PARTNER_WEBHOOK_SECRET`, or `none` if every country open to sign-up (`SIGNUP_REGIONS`) is in `record` custody; `SMS_PROVIDER` must be set and `NOTIFIER` must be `sms` or `whatsapp`.
- Whenever a messaging configuration is given, in any environment, it is validated at import: `SMS_PROVIDER=twilio` needs `TWILIO_ACCOUNT_SID`, `SMS_API_KEY` and a sender (`SMS_FROM` or `TWILIO_MESSAGING_SERVICE_SID`); a `NOTIFIER` other than `log` needs `SMS_PROVIDER`; `NOTIFIER=whatsapp` needs `WHATSAPP_FROM`.
- Outside live, secrets are generated once into `.local/` (mode 0600, git-ignored) and the webhook secret is the public constant `sandbox-webhook-secret`.
- Only outside live: login codes are returned in API responses, `GET /api/config/sandbox` lists users, `wallet.verify` raises KYC in one tap, the simulated partner settles everything, and `server/seed.js` runs (it refuses any other env).

If `SMS_PROVIDER` is set outside live, login codes are sent by SMS and still returned in the API response: a sandbox is never a safe place for real users.

## Login codes (OTP), `server/auth.js`

- 6 digits from `crypto.randomInt`, valid 5 minutes, stored as `sha256(phone:code:JWT_SECRET)` in `otps` (one per phone).
- 5 wrong tries per code, then a new code is needed.
- Per phone, rolling 24 hours (`otp_events`): at most 5 sends and 10 failures in `live` and `test`; 50 and 50 in sandbox. Failures are counted per phone, so re-sending does not reset them.
- `/api/auth/*` is limited to 20 requests a minute per IP.
- The same `issueOtp`/`consumeOtp` protect public link actions, sent to the link's party phone.
- Not done: captcha or device attestation, number-type checks, per-IP-prefix caps, delivery receipts (a code is considered sent when Twilio accepts the request).
- Sending: `server/messaging.js` posts to Twilio after the caps check. A send counts against the daily cap even if the provider refuses it, the caller gets a 502, and the message body is never logged.

## PIN and lockout

- 4–6 digits; repeated digits and straight runs (`1234`, `9876`) are refused. Stored as `salt:scrypt(pin, salt, 32)`.
- Required to open a session on a new device (after the OTP) and to confirm every intent.
- 5 consecutive failures lock the PIN for 15 minutes (423). Failures are counted in their own transaction and audited (`pin.failed`). A success resets the counter.
- Forgotten code: `POST /api/auth/pin/reset` with the `pinToken` issued after a login code and a new PIN. It replaces the code, clears the lockout, revokes every existing session, writes `pin.reset` to the audit log and an in-app message, and starts a hold: for `PIN_RESET_HOLD_HOURS` (24) every money confirmation answers 423. A login code proves possession of the SIM, not identity, so the hold is what protects against a stolen unlocked phone or a SIM swap: the owner has that time to get the account frozen. The hold does not cover actions taken from public links, which never ask for the PIN.
- A frozen account cannot reset its code.

## Sessions, refresh rotation, revocation

- Access token: JWT HS256, 15 minutes, `{ sub, sid, typ: 'access' }`. Each request checks that the session exists and is not revoked, so revocation is immediate.
- Refresh token: random 32 bytes, stored hashed in `sessions.refresh_hash`, sent as cookie `nexus_rt=<sid>.<token>` (httpOnly, `SameSite=Strict`, `Path=/api/auth`, `Secure` in live). Every refresh rotates it; the old value is then rejected. Sessions expire 30 days after creation.
- The client keeps the access token in memory only (`src/api.js`).
- Logout revokes the session. Freezing a user revokes all their sessions; a frozen account cannot POST, and its wallet refuses postings.
- Purpose tokens (`pinToken` 5 min, `signupToken` 15 min) are JWTs with a `purpose` claim and cannot be used as access tokens.
- Not done: "log out other devices", device binding, cooling-off on new payees, reuse detection of a rotated refresh token.

## Authorization

- **Per action** (`engine.js`): module enabled for region and persona, action custody matches the region, not in the persona's `deny`, required role active. Dispatch uses `Object.hasOwn`.
- **Per row**: every row action loads the row scoped to the caller: `escrowFor` (payer/payee, role, status), `step` (job role and stage status), `loadTontine` (membership), `owned` (orders by seller, invoices by user), `customerFor`, `beneficiary`, `settleRecorded` (only the non-recording party).
- **Admin**: `requireRole('admin')` on `/api/admin`. An admin cannot change their own admin role.
- **Registration**: the phone must start with the chosen region's dial code.

## Public links

- Token: 18 random bytes (base64url), stored as `sha256(token + LINK_SECRET)` in `links`; expires after 30 days (7 for tontine reminders). Bound to one `kind`, one row and usually one party. `revoked_at` exists but nothing sets it.
- **With the link alone** anyone can: view the page (masked names, masked phone, amounts, status), see job stage photos, upload a photo to a job link, and start the no-OTP actions: pay by mobile money (`escrow.pay`, `job.fund`, `order.pay`, `tontine.pay`) and, for direct-payment orders, `order.claimPaid` with any phone. Paying from your own mobile money is self-authorizing; the partner asks the payer to approve on their phone.
- **With a code sent to the party's phone**: confirm or reject a recorded payment, release or dispute an escrow, mark a stage done or received, validate a stage, accept a tontine, report a payment, confirm receipt of an order.
- The act endpoint only accepts an action the current view offers, so state rules apply.
- A link without a party (an order created without a buyer phone) cannot run OTP actions.

## Masking and lookup limits

- `mask()` shows first name and last initial ("Fatou D.") in reviews, feeds, rows, notifications and public pages, to everyone except the person. Users see their own beneficiaries and customers under the names they typed.
- `findUser` (wallet-to-wallet: `send`, `cashIn`) is limited to 40 lookups a day per user, counted and logged in `audit_events` (`action = 'lookup'`) outside the caller's transaction, so rolled-back quotes still count. A lookup reveals whether the number has an account and its masked name.
- `findParty` (any phone) creates a party row without revealing anything about it.

## Uploads

`server/uploads.js`:
- Accepted types `image/jpeg`, `image/png`, `image/webp`, `image/heic`, up to 6 MB. Every image is decoded and re-encoded by sharp to JPEG quality 80, auto-rotated, at most 1600×1600. Re-encoding drops EXIF (GPS, device). Undecodable input is refused.
- Position (`lat`, `lng` from the browser, optional) and `capturedAt` are stored as data in `uploads.meta`, not in the file. Files are written to `UPLOAD_DIR` as `<id>.jpg`, with their SHA-256.
- Who can view (`GET /api/uploads/:id`): the uploader; any admin; either party of a job whose stage lists the photo as proof; either party of the escrow of a dispute whose evidence references it. Via a job link: only photos attached to that job's stages.
- Gaps: a stage proof id is not checked to belong to the uploader; anyone with a job link can upload; no malware scan, no quota, no deletion.

## Webhook signatures

`handleWebhook` (`server/rails.js`): HMAC-SHA256 of the raw body with `PARTNER_WEBHOOK_SECRET`, compared in constant time; event id deduplicated in `webhook_events` inside the same transaction as the effect; operation looked up by `providerRef` and locked; ignored unless `pending`; amount and currency must match exactly. No timestamp, so a captured signed body could be replayed only as a duplicate (ignored).

## Rate limits and trust proxy

See [api.md](api.md#conventions). `app.set('trust proxy', TRUST_PROXY)`: set it to the exact number of proxy hops, or every client shares the proxy's IP and one abuser locks out everyone. Limits are per process (in memory); with several processes they multiply.

## Other HTTP hardening

Helmet defaults (CSP `default-src 'self'`, images also `data:` and `blob:`, HSTS, no sniff, frame-ancestors self), `x-powered-by` off, JSON body 20 kB, logs redact `authorization`, `cookie`, `*.pin`, `*.code`.

## Audit log

`audit_events (actor_type, actor_id, action, object_type, object_id, data, ip, created_at)`. Written for: user creation, session open, PIN failures, lookups, every engine action (`<module>.<action>` with input), every public link action (`link.<kind>.<action>`, actor type `party`), every admin write, KYC changes, CLI admin grants (`actor_id = 'cli'`). Not append-only at the database level (unlike postings). Readable at `GET /api/admin/audit`.

## Admin two-person rule

- Disputes: one admin proposes (`release`, `refund`, `split` + note); a different admin approves. Re-proposing replaces the proposal and the proposer.
- Adjustments: proposed then approved by a different admin; posted once (`idem adjustment:<id>`).
- Not under the rule: freeze/unfreeze, KYC level, role grants (including granting `admin` to someone else), outbox retry. They are audited.

## Agent provisioning and commission rules

- The `agent` persona is `restricted`: sign-up creates the role `pending`; `float.cashIn`/`cashOut` need it `active`, set by an admin (`POST /api/admin/users/:id/roles/agent`).
- Cash-in: agent wallet → customer wallet, customer must have an account in the same country.
- Cash-out: the customer creates an 8-digit code (`wallet.cashCode`, 15 minutes, stored hashed with `LINK_SECRET`); the agent enters it; the code is consumed by compare-and-set; an agent cannot cash out their own code.
- Commission: 50 bps per operation, accrued, paid by the hourly job after one hour, withheld (and the op flagged) if the same agent did the opposite operation with the same customer within 24 hours. Gap: if the first leg's commission has already been paid when the second leg happens, only the second is withheld.

## Personal data

| Data | Where |
|---|---|
| Phone, name, region, persona, KYC level, PIN hash | `users` |
| Phone and name of every counterparty (no consent recorded) | `parties` |
| Names typed by users | `beneficiaries.name`, `customers.name`, `orders.customer_name`, `invoices.supplier` |
| Free-text purposes and titles | `recorded_payments.purpose`, `escrows.title`, `jobs.title`, `postings.title` (append-only) |
| Counterparty reference in the ledger | `postings.cp_party` (append-only) |
| Phones and IPs | `otp_events`, `audit_events`, `provider_ops.phone` |
| Notification texts (names masked) | `notifications` |
| Photos and optional GPS | `UPLOAD_DIR`, `uploads.meta` |
| Last 4 digits of an ID number (sandbox verify) | `audit_events.data` |
| Logs | stdout (pino), includes phones in some messages |

Not handled: erasure (postings and entries are append-only by trigger and hold free-text titles), data export, retention schedules, consent records for counterparties, data residency (one database for all countries), encryption at rest beyond what the host provides.

## Known gaps and non-goals

Stated plainly.

**Still open:**
1. SMS and WhatsApp sending (`server/messaging.js`) is tested only against local stand-ins: no real Twilio account, gateway phone, sender registration or approved WhatsApp template exists yet. With `SMS_PROVIDER=smsgate`, login codes transit the gateway project's relay in clear, and an accepted request means queued on the phone, not delivered ([pilot.md](pilot.md)). No opt-in or opt-out is recorded for WhatsApp recipients, and a retried `notify.send` can deliver the same message twice if the process dies between the send and the status update.
2. The coverage check is implied by the ledger's zero-sum rule and does not compare with the partner's actual balance ([money.md](money.md#reconciliation-and-coverage)).

**Fixed after the first documentation pass** (each has a regression test in `server/test/fixes.test.js`):
- A refused recorded payment returns its escrow, job stage, order or tontine contribution to the unpaid state (`onRecordedRejected` hooks), so it can be reported again.
- A failed payout from a system account no longer strands money there: a failed remittance refunds the sender in full, fee included, and marks it `failed` (`delivered` on success); a failed escrow release puts the money back in escrow and the escrow back to `held`; any other case alerts the admins (`payoutHandlers` in `rails.js`).
- Escrow releases are exempt from the payee's balance cap.
- Failed payouts no longer count toward daily and monthly limits.
- Agent commissions are paid after 24 hours, so the reverse leg of a round trip is always seen before payment.
- The artisan's link page offers "Demander le financement" for a held job, so an artisan without the app can start.
- A supplier invoice is `paying` until the partner confirms; a failed payment reopens it.
- Blocked forms answer 409 with their message; an unknown dispute or adjustment answers 404; a signed non-JSON webhook answers 400.
- Outbox jobs hold a five-minute lease while `running`; a job left behind by a crash runs again.
- Malformed JSON gets the French "Requête invalide".
- `escrow.refund` and `orders.refund` are money actions: quote first, PIN to confirm.
- Either side of an open dispute can add evidence (a statement of up to 500 characters, a photo, or both; 10 pieces per side): action `evidence` on the escrow, job or order in the app, and on the public link behind a login code. A photo must have been uploaded by the same person. Evidence closes when the dispute is resolved.
- A forgotten secret code can be replaced after a login code, with a 24-hour hold on money actions (above).
- Photos are served again: with the default `UPLOAD_DIR` (`.local/uploads`) every `GET /api/uploads/:id` answered 404, because Express refuses a bare absolute path containing a dot-segment.

**Not implemented:** sanctions/PEP screening, transaction monitoring and suspicious-activity reporting, partner statement reconciliation, catalog versioning, device binding, CSV export for regulators, off-server backups, metrics and error tracking, i18n, link revocation UI.

**Non-goals for this codebase:** Nexus holding customer funds itself; credit or lending; card payments.
