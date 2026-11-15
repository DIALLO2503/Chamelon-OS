# Testing

Related: [money.md](money.md), [partner-integration.md](partner-integration.md).

## Organisation

- Runner: Node's built-in `node:test`, no framework. `npm test` runs `node --test --test-concurrency=1 server/test/money.test.js server/test/flows.test.js server/test/fixes.test.js`.
- `server/test/money.test.js` (14 tests): ledger, quotes, idempotency, limits, corridors, webhooks, concurrency, catalog.
- `server/test/flows.test.js` (13 tests): end-to-end journeys, several over real HTTP (the Express `app` on a random port) including public links.
- `server/test/fixes.test.js` (15 tests): regression tests for the issues fixed after the first documentation pass ([security.md](security.md#known-gaps-and-non-goals)).
- `server/test/messaging.test.js` (5 tests): SMS login codes and WhatsApp/SMS notifications against a local HTTP stand-in for Twilio's Messages API (request shape, credentials, provider failure, SMS fallback, outbox retry).
- `server/test/pilot.test.js` (6 tests): the link funnel, and the pilot configuration: sign-up limited to two countries, one SMS gateway phone per country, the first admin created from the command line, live boot without a payment partner.
- `server/test/helpers.js` sets `NEXUS_ENV=test` before importing anything, so tests use `postgres://nexus:nexus@localhost:5432/nexus_test` unless `DATABASE_URL` is set. Each file starts with `resetDb()`: **`DROP SCHEMA public CASCADE`**, then migrations. Never run tests with `DATABASE_URL` pointing at real data.
- In `test`, rate limits are effectively off, OTP caps are the live ones (5 sends, 10 failures a day), logs are silent, and the sandbox partner does not auto-settle: tests settle explicitly.

Expected result: `# tests 53`, `# pass 53` (52 and one skipped if the interface has not been built: the link-preview test reads `dist/index.html`).

## Helpers

| Helper | Does |
|---|---|
| `user(region, persona, { kyc = 1, fund, roles })` | Creates a user with PIN 2580 and a fresh phone (`DIAL` map per region); optional top-up and active roles |
| `act(u, module, action, input, row)` | `engine.perform`, and if an intent comes back, `confirmIntent` with the PIN and fresh keys |
| `quote(...)` | `engine.perform` only |
| `settleAll(outcome = 'succeeded')` | Drains the outbox (assigns `provider_ref`), then calls `rails.simulateSettle` for every pending operation: a signed webhook exactly as the partner would send. `'failed'` simulates rejections. |
| `topup(u, major)` | `wallet.topup` + `settleAll` |
| `bal(u)` | Wallet balance in minor units |
| `healthy(assert)` | Reconcile returns nothing, every currency sums to zero, coverage ok |
| `linkFor(kind, refId, partyId)` | Creates a public link token as the app would |
| `phone(region)`, `partyOf(u)`, `partyByPhone(p)`, `idem()` | Small utilities |

## What each test proves

**Ledger and money core (`money.test.js`)**
- Ledger refuses unbalanced, fractional and overdrawing entries; postings and entries are append-only.
- A top-up credits nothing until the partner confirms.
- A quote moves nothing and queues nothing; confirmation needs the right PIN; replay with the same key returns the same response; a used intent cannot run again; the recipient's name is masked.
- If the FX rate changes between quote and confirmation, confirmation is refused and nothing moves.
- Idempotency key: required, replayed once, 409 when reused for other content.
- KYC limits: level-0 balance cap blocks a credit, verification raises it, the per-operation cap blocks a large withdrawal.
- Recipient lookups: unknown numbers get "no account", the 41st lookup in a day is refused.
- Corridors: no hold in a `record` country, no UAE→Guinea beneficiary, no cross-border send; FR→MA hold quotes 100 € = 1 085 DH.
- Diaspora build: an EUR client funds a MAD stage (10 850 DH costs exactly 1 000 €); on validation the artisan without the app gets a MAD payout to their phone.
- Dispute: a non-admin cannot propose, the proposer cannot approve, a second admin applies a split that pays both sides exactly.
- A payout the partner rejects is reversed to the source wallet.
- Webhooks: bad signature refused, wrong amount refused, duplicate event ignored.
- Concurrency: six parallel releases pay once; five parallel 300 sends from 1 000 succeed exactly three times.
- Catalog validation throws on a persona pointing at an unknown module.

**Journeys (`flows.test.js`)**
- Sign-up and sign-in over HTTP: no sign-up without a verified phone, dial code must match the country, obvious PINs refused, nav labels per persona, OTP + PIN login, refresh rotation kills the old token, logout revokes.
- Login codes: wrong guesses count across re-sends; the third send after 10 failures is 429.
- Stage 1 (record): Moroccan artisan and a client without the app go through done → validate (link, OTP) → paid → received; no posting exists.
- Stage 2 protected order: buyer without the app pays from the link; held until delivery confirmation; a duplicate payment is refunded automatically.
- Protected order auto-release after the delay when the buyer is silent.
- Tontine (held): invitations accepted (app and link), order drawn, contributions from wallet and link, pot paid out, round 2 opens.
- Agents: self-registered agent is pending and cannot act; once approved, cash-in and code-based cash-out work, a code is single use, same-day round trip commissions are withheld.
- Scheduled transfer runs once even when two runs overlap; recipient without the app is paid in GNF; fee charged.
- Credit book: WhatsApp reminder link, customer reports a repayment from the statement page, shop confirms, debt drops.
- Reputation counts distinct people: five sends from one person count as one.
- Freeze revokes sessions and blocks money; a manual adjustment needs a second admin; overview reconciles.
- Blue-collar: a foreman pays a crew, one worker confirms in the app and one from the link; goal progress and Niya zellij tile update.
- Reputation level lowers the sending fee: from 1,50 € to 0,75 €.

**Regressions (`fixes.test.js`)**
- A refused recorded payment puts the job stage back to "to pay"; the client can report it again.
- A failed remittance payout refunds the sender, fee included; status `failed`, then `delivered` on a successful retry.
- A failed escrow release puts the money back in escrow (`held`).
- Failed withdrawals do not use up the daily limit.
- A supplier invoice is `paying` until settled, reopened on failure.
- Escrow refund needs a quote and the PIN.
- An artisan without the app requests funding for a held stage from the link.
- Blocked form → 409, malformed JSON → French 400, non-JSON signed webhook → 400, unknown dispute → 404.
- An outbox job left `running` is retried after its lease.

## Run one test

```bash
node --test --test-name-pattern="webhooks" server/test/money.test.js
```

The pattern matches test names. Each file resets the database, so run one file at a time.

## Browser tests

`npm run build && npm run e2e` runs `e2e/app.test.js` with Playwright on a phone-sized screen (4 tests): sign-up with consent, sign-in with a wrong then right secret code, a person without the app confirming a payment from a link with a code, and the terms page. It seeds and starts its own sandbox server on port 3190, on the database in `E2E_DATABASE_URL` (default local `nexus_e2e`), which it **wipes** first. CI runs it in its own job.

## Not tested

- Most of the frontend: the browser tests cover sign-up, sign-in and one public link, not the modules, the action sheet's money flows or the admin console.
- Load and performance, multi-process scheduler and outbox behaviour.
- A real partner; a real Twilio account or gateway phone (the messaging and pilot tests use local stand-ins, so delivery, sender registration and WhatsApp template approval are unverified); live mode beyond its configuration checks.
- Upload re-encoding and most upload access rules (only dispute evidence photos are covered); most admin endpoints (users, KYC, roles, outbox retry, audit); link expiry; PIN lockout; the reconciliation alert path.
- The gaps listed in [security.md](security.md#known-gaps-and-non-goals).

## Adding a test for a new action

1. Put it in the file that fits (core rule → `money.test.js`, journey → `flows.test.js`).
2. Create users with `user(region, persona, { fund })`, act with `act(...)` (money actions are quoted and confirmed automatically), and settle external operations with `settleAll()` (or `settleAll('failed')`).
3. Assert balances with `bal(u)` and rows with `one(pool, …)`.
4. End every money test with `await healthy(assert)`.
5. For link flows, use the `http` and `linkAct` helpers in `flows.test.js` (they request an OTP and use `sandboxCode`).
6. For a new country, add its prefix to `DIAL` in `helpers.js`.

```js
test('orders: seller cancels a pending order', async () => {
  const seller = await user('SN', 'seller')
  await act(seller, 'orders', 'create', { item: 'Pagne', amount: '5000', customer: 'Awa' })
  const o = await one(pool, 'SELECT * FROM orders WHERE seller_id=$1', [seller.id])
  await act(seller, 'orders', 'cancel', {}, o.id)
  assert.equal((await one(pool, 'SELECT status FROM orders WHERE id=$1', [o.id])).status, 'cancelled')
  await healthy(assert)
})
```
