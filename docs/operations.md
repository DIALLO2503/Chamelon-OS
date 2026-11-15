# Operations: running a pilot

For the founder or the first ops hire. Related: [money.md](money.md), [security.md](security.md), [partner-integration.md](partner-integration.md), [api.md](api.md) (admin section).

For the two-country pilot on a single server, follow [pilot.md](pilot.md).

## Deployment shape

- One Node 20.9+ process: `NEXUS_ENV=live node server/index.js` after `npm ci && npm run build`. It serves `/api` and the built PWA from `dist/` (any non-API `GET` returns `dist/index.html`).
- One managed PostgreSQL 14+ database. Pool of 10 connections per process.
- TLS terminated by a reverse proxy or the platform; set `TRUST_PROXY` to the hop count and `PUBLIC_URL` to the public origin (links in WhatsApp messages use it).
- A persistent volume for `UPLOAD_DIR`.
- Several processes are possible: the scheduler runs in one at a time (advisory lock) and the outbox uses `SKIP LOCKED`. Rate limits are per process.
- Logs: pino JSON on stdout. No metrics, tracing or error tracking are wired.

## Environment variables

See the table in the [README](../README.md#configuration). Live minimum: `NEXUS_ENV=live`, `DATABASE_URL`, `JWT_SECRET`, `LINK_SECRET`, `PUBLIC_URL`, `PAYMENT_PROVIDER=partner`, `PARTNER_BASE_URL`, `PARTNER_API_KEY`, `PARTNER_WEBHOOK_SECRET`, `SMS_PROVIDER=twilio`, `SMS_API_KEY`, `TWILIO_ACCOUNT_SID`, `SMS_FROM` or `TWILIO_MESSAGING_SERVICE_SID`, `NOTIFIER` (`sms`, or `whatsapp` with `WHATSAPP_FROM` and `WHATSAPP_TEMPLATES`), and `TRUST_PROXY` behind a proxy. Messaging has not yet been run against a real Twilio account ([security.md](security.md#known-gaps-and-non-goals)).

## Migrations

`migrate()` (`server/db.js`) runs at server start and in the seed: every `server/migrations/*.sql` not yet in `schema_migrations`, in file-name order, each in its own transaction. Add a change as a new file (`003_<name>.sql`); never edit an applied one. There is no down-migration.

## First admin

1. Sign up in the app with the admin's phone (any profile; admins are ordinary accounts with a role).
2. `NEXUS_ENV=live DATABASE_URL=… JWT_SECRET=… LINK_SECRET=… <partner and SMS vars> npm run admin:create -- +33612345678` (the CLI loads the same config, so live needs the same variables).
3. Create a second admin the same way, or from the console (`POST /api/admin/users/:id/roles/admin`): disputes and adjustments need two different admins.

The admin console opens from Services → "Console d'administration".

## Seeding rules

`npm run seed` (`node --env-file=env/sandbox.env server/seed.js`) refuses to run outside sandbox, migrates, and does nothing if any user exists. It creates 31 accounts (one per profile and country) with PIN 2580 and drives every action through the engine, settling partner operations itself, so balances match the ledger. To reseed: the **Recommencer la démo** button on the sign-in screen (`POST /api/sandbox/reset`: truncates every table except `schema_migrations`, then seeds again; refused unless `NEXUS_ENV=sandbox`, hidden with `SANDBOX_RESET=off`), or drop and recreate the `nexus` database, then seed. Never point a sandbox or test run at a live `DATABASE_URL`: the tests drop the `public` schema.

## Scheduler

`server/scheduler.js`, started by `server/index.js`. A tick every 60 seconds, the first at boot. Each tick takes `pg_try_advisory_lock(7340021)`; a process without the lock skips the tick.

| Job | Cadence | What |
|---|---|---|
| Expire intents | every minute | `quoted` intents past `expires_at` → `expired` |
| `autoRelease()` | every minute | Escrows `held` with `auto_release_at` passed are released (up to 50 per tick) |
| `runDueSchedules()` | every minute | Monthly remittances due; one transaction and idempotency row `schedule:<id>:<date>` each; failure stored in `remit_schedules.note` and the user notified |
| `tontineReminders()` | first tick, then every 60th (about hourly) | Members who have not paid get a link and a reminder from two days before `next_due`, deduplicated per day |
| `settleCommissions()` | hourly | Pays or withholds accruals older than one hour ([money.md](money.md#agent-cash-in-cash-out-commission)) |
| `checkLedger()` | hourly | Reconciliation and coverage; on failure `LEDGER ALERT` in the log and an in-app message to every admin (once per hour) |

## Outbox and retries

`server/rails.js`. Kinds: `provider.payout`, `provider.collect`, `notify.send`. Statuses: `pending`, `running`, `done`, `failed`.

- The worker polls every second, claims up to 20 due `pending` rows with `FOR UPDATE SKIP LOCKED`, marks them `running`, runs them outside the transaction.
- On error: back to `pending` with `next_at = now + 2^attempts` seconds (2, 4, … 128 s) and `last_error`; after 8 attempts `failed`.
- Provider handlers skip an operation that already has a `provider_ref`, and send `Idempotency-Key = provider_ops.id`, so a retry does not pay twice if the partner honours the key.
- A row taken by the worker holds a five-minute lease (`next_at = now() + 5 min`); if the process dies mid-call it becomes due again and is retried with the same provider idempotency key.

## Daily checks

1. `GET /api/admin/overview` (console home): `reconciliation.ok` true, every `safeguarding[].ok` true, `failed_jobs` 0, `pending_roles`, open `disputes`, proposed `adjustments`, `frozen` count.
2. Outbox: `GET /api/admin/outbox?status=failed` and, in SQL, rows `running` older than a few minutes.
3. Pending payouts older than an hour: `SELECT * FROM provider_ops WHERE status='pending' AND created_at < now() - interval '1 hour'`.
4. Escrows `held` with `auto_release_at` in the past (release blocked, for example by a balance cap).
5. Log search for `LEDGER ALERT`, `outbox job failed permanently`, `auto-release failed`, `schedule run failed`, `commission settlement failed`, `scheduler tick failed`.
6. Once a partner exists: compare its statement per currency with `-sys:rail` (not implemented in code).

## Runbooks

### Runbook: reconciliation or coverage alert

1. Stop money movement if the cause is unknown: freeze affected users, or stop the process.
2. `GET /api/admin/overview` → `reconciliation.mismatches` lists accounts whose cached balance differs from the sum of postings (`balance` vs `posted`).
3. A mismatch means a balance was changed outside `post()`. Find it: `SELECT * FROM postings WHERE account_id = '<id>' ORDER BY id DESC`, and the audit log around the time.
4. Do not edit `accounts.balance` to hide it. If the postings are right, fix the cache (`UPDATE accounts SET balance = <posted> WHERE id = …`) in a reviewed transaction and record why in `audit_events`. If the postings are wrong, correct with a new entry (adjustment), never by editing postings (they are append-only).
5. A coverage failure means unbalanced data or an account kind missing from the formula ([money.md](money.md#reconciliation-and-coverage)).

### Runbook: failed outbox job

1. Console → outbox (failed) or `GET /api/admin/outbox`; read `last_error`.
2. Fix the cause (partner down, bad credentials, bad phone).
3. `POST /api/admin/outbox/:id/retry` (failed → pending, attempts 0).
4. A `notify.send` failure carries Twilio's status and error code in `last_error` (for example `Twilio 400 (code 21211)` for an invalid number, `63016` for a WhatsApp message outside an approved template). Fix the number, the sender or the template mapping in `WHATSAPP_TEMPLATES`, then retry.
5. `running` rows are retried automatically after their five-minute lease. If one keeps coming back, check with the partner whether the call was received (reference = `provider_ops.id`).

### Runbook: payout stuck pending

1. `SELECT * FROM provider_ops WHERE id = …`. No `provider_ref` → the outbox call has not succeeded (see above). With a `provider_ref` → waiting for the webhook.
2. Ask the partner for the operation's status by reference.
3. If the partner never delivered the webhook, have it resend (same event id is safe). Nexus has no status-polling call.
4. In sandbox only, `simulateSettle(opId, 'succeeded'|'failed')` in `server/rails.js` settles it.
5. A failed remittance refunds the sender and a failed escrow release returns to escrow automatically. Other failed payouts from a system account (refund or collection return to a phone, tontine pot) raise an `alert.payout_failed` notification to admins: the money sits in `sys:fx_out`, `sys:escrow` or `sys:returns`. Fix the phone number with the person and re-pay with a reviewed SQL transaction using `post()` semantics, or an adjustment if the person has a wallet.

### Runbook: dispute handling

1. Console → disputes. Read the reason, the escrow, the stage (with photos), the evidence each side added ("Pièces": statements and photos, each labelled with its author) and both parties. Either side can keep adding evidence until the dispute is resolved, from the app or from their link. Contact both (the in-app text promises contact within 48 hours and a decision within 5 working days).
2. Admin A: `POST /api/admin/disputes/:id/propose` with `outcome` and a `note` (shown to both parties), and `payeeAmount` in minor units for a split.
3. Admin B reviews and `POST /api/admin/disputes/:id/approve`. Money moves, both parties are notified, the losing side is recorded in `resolution.against` (it lowers their reputation).
4. There is no way to attach evidence through the product today.

### Runbook: freezing an account

`POST /api/admin/users/:id/freeze { frozen: true, reason }`. Revokes all sessions, blocks POSTs, and makes every posting touching the user's wallet fail (including incoming credits and webhook-driven ones, which will retry). Unfreeze with `frozen: false`. Funds stay where they are.

### Runbook: correcting a balance

Never edit `accounts` or `postings`. Admin A `POST /api/admin/adjustments { userId, amount, reason }` (signed minor units, user's wallet currency); admin B approves. It posts against `sys:adjustments`, which is Nexus's own money: in live it must be matched by a real transfer at the partner. Only user wallets can be adjusted.

### Runbook: approving an agent

1. The agent signs up with the agent profile; the role is `pending` (console shows pending roles).
2. Do the partner's agent onboarding (KYB, contract, float funding) outside Nexus.
3. Console → user → "Valider l'agrément d'agent" (`POST /api/admin/users/:id/roles/agent { status: 'active' }`). The agent is notified.
4. Revoke with `status: 'revoked'`. Watch `cash_ops.flagged`.

### Runbook: a link reached the wrong person

Console → Opérations → "Couper les liens d'un numéro", with a reason. Every active link sent to that number stops working; the user re-sends a fresh one from the app. Acting on a link always required a code sent to the right phone, so a forwarded link exposed what the page shows, not the ability to act.

### Runbook: account closure request

The person asks from Services → "Vos données"; admins receive an in-app alert and `users.closure_requested_at` is set (also in the users export). Contact the person, check nothing is pending (open job stage, dispute, tontine round), then freeze the account. Records that the other party also relies on (confirmed payments, disputes) are kept. Erasing the remaining personal data is a manual database operation: **no automated deletion exists**.

### Runbook: rotating secrets

| Secret | Effect of rotation |
|---|---|
| `JWT_SECRET` | All access, pin and signup tokens die (users sign in again; refresh cookies still work, they are not JWTs). Pending OTPs become invalid. |
| `LINK_SECRET` | **Every public link and every unused cash-out code stops working** (both are hashed with it). Re-send links (`share` actions). No dual-key support. |
| `PARTNER_WEBHOOK_SECRET` | Coordinate with the partner: only one secret is accepted at a time, so webhooks fail (and should be retried by the partner) during the switch. |
| `PARTNER_API_KEY`, `SMS_API_KEY` | Restart with the new value. |
| Database password | Update `DATABASE_URL`, restart. |

In sandbox, delete `.local/jwt-secret` or `.local/link-secret` to regenerate.

### Backup and restore

**Not automated.** Nothing in the repository backs up the database or `UPLOAD_DIR`. Use the managed database's point-in-time recovery, or at least a daily `pg_dump -Fc "$DATABASE_URL" > nexus-$(date +%F).dump` plus a copy of `UPLOAD_DIR`. Restore with `pg_restore -d <empty db> nexus-<date>.dump`, then run reconciliation before reopening. After a restore, operations confirmed by the partner after the backup must be replayed from the partner's records (webhooks resent). A restore drill has never been run.
