# Money: the ledger and every flow

Code: `server/ledger.js`, `server/core.js`, `server/modules/*.js`, `server/rails.js`, `safeguarding()` in `server/admin.js`.
Related: [custody-stages.md](custody-stages.md), [architecture.md](architecture.md), [operations.md](operations.md#runbook-reconciliation-or-coverage-alert).

In `record` custody no money moves through Nexus and **nothing is posted to the ledger**: payments are rows in `recorded_payments` (see [custody-stages.md](custody-stages.md)). Everything below applies to `held` custody, where Nexus keeps a shadow ledger of funds that a licensed partner holds.

## Model

| Table | Role |
|---|---|
| `accounts` | One row per `(owner, kind, currency)`. `balance` is a cache of postings. `floor` is `0` or `NULL` (may go negative). `CHECK (floor IS NULL OR balance >= floor)`. |
| `entries` | One business event. `kind` (e.g. `p2p`, `payout`), optional unique `idem`. Append-only (trigger). |
| `postings` | Signed lines of an entry: `amount` (minor units, never 0), `title`, `cp_party` (counterparty), `ref`, `icon`. Append-only (trigger). |

All amounts are integers in **minor units** (cents for EUR/MAD/AED; units for XOF/GNF, which have no decimals). BIGINT values are parsed as JS numbers and the parser throws if one is not a safe integer (`server/db.js`).

### Accounts and kinds

`owner` is a user id, `system`, or `tontine:<id>`.

| Kind | Owner | May go negative | Meaning |
|---|---|---|---|
| `wallet` | user | no | A user's balance. Subject to KYC limits. |
| `escrow` | system | no | All funds held in escrow, per currency (escrows, job stages, protected orders). |
| `pot` | `tontine:<id>` | no | One tontine group's collected contributions. |
| `rail` | system | **yes** | Money that crossed the partner boundary. Collections debit it; settled payouts credit it. Its negative balance is what the partner should be holding. |
| `fx` | system | **yes** | FX position per currency. A conversion credits the source currency and debits the target currency. |
| `fx_out` | system | no | Converted money waiting to be paid out in the target currency (remittance or escrow release to a mobile-money payout, cross-currency refund). |
| `payout_pending` | system | no | Suspense: money debited from its source and sent to the partner, not yet confirmed. |
| `returns` | system | no | Collections that arrived but could not be applied (duplicate, late, cancelled), on their way back to the payer. |
| `remit_transit` | system | no | A remittance between the sender's debit and its delivery (passes through within one transaction). |
| `fees` | system | no | Nexus revenue (remittance fees). |
| `commissions` | system | **yes** | Agent commissions paid. Nexus's own expense. |
| `adjustments` | system | **yes** | Manual corrections approved by two admins. Nexus's own expense or recovery. |

`OPEN = rail, fx, commissions, adjustments` (`ledger.js`) are the only kinds created with `floor = NULL`, and only for the `system` owner. They stand for money outside the customer ledger: the partner's account, the conversion counterparty, and Nexus's own operating money. Everything else has a floor of zero, enforced by the database.

### Posting rules (`post()`)

1. Lines with amount `0` are dropped. Every amount must be a safe integer.
2. At least two lines, and the lines must **sum to zero per currency**, or the entry is refused (`ledger: entry does not balance`). Cross-currency moves therefore always pass through two `fx` accounts (`legs()` + `expand()`).
3. If `idem` is given and an entry with that `idem` exists, the existing entry id is returned and nothing is posted. Webhook-driven and scheduled entries use this: `topup:<op>`, `settle:<op>`, `reverse:<op>`, `fund:<op>`, `order:<op>`, `return:<op>`, `commission:<accrual>`, `adjustment:<id>`.
4. All touched accounts are locked `FOR UPDATE` in id order (no deadlock, no interleaving).
5. KYC limits are checked for every user wallet in the entry (next section). A frozen user's wallet refuses any entry (403).
6. Postings are inserted and cached balances updated. A floor violation (`23514`) becomes `400 Solde insuffisant`.

`post()` must run inside a transaction (`tx()`); every caller does.

### Limits per KYC level

Levels: `0` phone verified, `1` identity verified, `2` enhanced (`users.kyc_level`). Limits live in `REGIONS[id].limits` and are placeholders until the partner's tier rules are signed.

- **single**: one outflow from the wallet in one entry.
- **daily**: outflows over the last 24 hours (rolling). **monthly**: outflows since the start of the calendar month (database time zone). A payout the partner failed and returned (`payout_reversed`) is subtracted, so it does not use up the limit.
- **balance**: the wallet balance after a credit. Not applied to entries of kind `escrow_refund`, `escrow_release`, `payout_reversed`, `adjustment`, `tontine_out`, `order_refund` (credits that undo or complete something must not get stuck).

Values in major units:

| Country | Level | single | daily | monthly | balance |
|---|---|---|---|---|---|
| MA (MAD) | 0 / 1 / 2 | 2 000 / 10 000 / 50 000 | 5 000 / 20 000 / 100 000 | 20 000 / 100 000 / 500 000 | 5 000 / 20 000 / 200 000 |
| SN (XOF) | 0 / 1 / 2 | 200 000 / 1 000 000 / 5 000 000 | 500 000 / 2 000 000 / 10 000 000 | 2 000 000 / 15 000 000 / 50 000 000 | 2 000 000 / 4 000 000 / 20 000 000 |
| GN (GNF) | 0 / 1 / 2 | 5 M / 20 M / 100 M | 10 M / 40 M / 200 M | 40 M / 200 M / 1 000 M | 10 M / 50 M / 300 M |
| FR (EUR) | 0 / 1 / 2 | 150 / 5 000 / 50 000 | 150 / 10 000 / 50 000 | 150 / 15 000 / 100 000 | 150 / 15 000 / 100 000 |
| AE (AED) | 0 / 1 / 2 | 3 000 / 35 000 / 200 000 | 3 000 / 35 000 / 200 000 | 3 000 / 100 000 / 500 000 | 3 000 / 35 000 / 200 000 |

MA and GN limits only matter once those countries switch to `held`.

### FX arithmetic and rounding

Rates are integers: units of each currency per 1 EUR, scaled by 1e8 (`FX_E8_PER_EUR` in `catalog.js`): EUR 1, MAD 10.85, XOF 655.957, AED 4.25, GNF 9 400.

`convert(minor, from, to, round)` in `core.js` computes `minor × rate[to] × 10^dec[to] / (rate[from] × 10^dec[from])` in BigInt. `round = 'down'` (default) truncates; `'up'` adds one minor unit when there is a remainder.

- What someone **receives** is rounded **down**: 100,00 € → `convert(10000,'EUR','XOF')` = **65 595 F CFA** (exact 65 595.7).
- What someone **pays** is rounded **up**: a 10 000 F CFA hold paid in euros costs `convert(10000,'XOF','EUR','up')` = **15,25 €** (exact 15.2449…; down would be 15,24 €).
- The rounding difference stays in the `fx` accounts, in Nexus's favour.
- `rateE8(from, to)` gives the cross rate; the remittance review stores it as `review.rate`, and `remittances.rate_e8` keeps it.

Rates are static in sandbox. In live they must come from the partner ([partner-integration.md](partner-integration.md)). FX positions are never revalued.

### Idempotency, three layers

| Layer | Key | Effect |
|---|---|---|
| HTTP | `Idempotency-Key` header, table `idempotency (user_id, key, request_hash, response)` | Required on direct actions and on confirm. Same key + same content → stored response. Same key + different content → 409. |
| Intent | `intents.status` `quoted → confirmed` compare-and-set, 10-minute expiry | A quote executes at most once. |
| Ledger and outbox | `entries.idem`, `outbox.idem`, `webhook_events.event_id` | A webhook or scheduled job replayed posts once and calls the provider once. |

## The flows

Each table lists the postings (`+` credits the account). `W(x)` is x's wallet, `sys:k` the system account of kind k. Worked numbers use sandbox rates.

### Top-up (collection to own wallet)

`wallet.topup` → `startCollection` (provider_ops `collection`, outbox `provider.collect`). Nothing is posted until the partner confirms. Webhook `collection.succeeded` → `collectionHandlers.topup`:

| Entry `topup` (idem `topup:<op>`) | XOF |
|---|---|
| `sys:rail` | −50 000 |
| `W(seller)` | +50 000 |

Example: Fatou tops up 50 000 F CFA. Her balance is 0 until the webhook, then 50 000. If the credit would exceed her balance cap, the webhook handler fails and the partner will retry; the money is at the partner but not credited (see [operations.md](operations.md#runbook-payout-stuck-pending)).

### P2P (same country, both have accounts)

`wallet.send` (quote + PIN). Recipient must be a user in the same region (`findUser`, logged, 40/day).

| Entry `p2p` | XOF |
|---|---|
| `W(Fatou)` | −500 |
| `W(Ibrahima)` | +500 |

No fee.

### Withdraw, and failed payout reversal

`wallet.withdraw` → `startPayout`:

| Step | Entry | Postings |
|---|---|---|
| Request | `payout` | `W(user)` −4 000, `sys:payout_pending` +4 000 |
| Partner says succeeded | `payout_settled` (idem `settle:<op>`) | `sys:payout_pending` −4 000, `sys:rail` +4 000 |
| Partner says anything else | `payout_reversed` (idem `reverse:<op>`) | `sys:payout_pending` −4 000, source account +4 000 |

The reversal credits the account the payout came from (`provider_ops.purpose.source`). For a wallet that is the user. For a payout from a system account, a handler registered for `purpose.type` (`payoutHandlers.failed` in `rails.js`) then moves the money on to its owner: a failed **remittance** refunds the sender in full in their currency (converting back through `sys:fx`, fee returned from `sys:fees`) and sets `remittances.status = 'failed'`; a failed **escrow release** converts back into `sys:escrow` and sets the escrow back to `held`. Without a handler, admins are alerted; see [operations.md](operations.md#runbook-payout-stuck-pending). On success, `payoutHandlers.succeeded` marks a remittance `delivered` and an invoice `paid`. Bill payment (`wallet.bill`) and supplier invoices (`invoices.pay`) are the same payout flow.

### Escrow hold, release, refund (same currency)

`escrow.hold` (payer creates and funds at once) or `escrow.fund` on a request.

| Step | Entry | Postings (XOF) |
|---|---|---|
| Hold 60 000 | `escrow_hold` | `W(payer)` −60 000, `sys:escrow` +60 000 |
| Release, payee has a held-country account | `escrow_release` | `sys:escrow` −60 000, `W(payee)` +60 000 |
| Release, payee without account | `payout` | `sys:escrow` −60 000, `sys:payout_pending` +60 000; then settle as above |
| Refund | `escrow_refund` | `sys:escrow` −60 000, `W(payer)` +60 000 |

`deliver()` in `modules/shared.js` decides wallet credit or mobile-money payout. A payer without an account funds from a link by collection: `sys:rail` −, `sys:escrow` + (entry `escrow_hold`, idem `fund:<op>`).

### Escrow, cross currency (France → Morocco build)

Karim (EUR) funds a 10 850 DH stage for Hassan, who has no app. `fundPlan` charges `convert(1085000,'MAD','EUR','up')` = 100 000 cents.

| Step | Entry | EUR | MAD |
|---|---|---|---|
| Fund | `escrow_hold` | `W(Karim)` −100 000, `sys:fx` +100 000 | `sys:fx` −1 085 000, `sys:escrow` +1 085 000 |
| Release (validate) | `payout` | | `sys:escrow` −1 085 000, `sys:payout_pending` +1 085 000 |
| Settled | `payout_settled` | | `sys:payout_pending` −1 085 000, `sys:rail` +1 085 000 |
| Or full refund | `escrow_refund` | `sys:fx` −100 000, `W(Karim)` +100 000 | `sys:escrow` −1 085 000, `sys:fx` +1 085 000 |

`escrows` stores `amount/currency` (what the payee gets) and `paid_amount/paid_currency` (what the payer paid). A full refund returns exactly `paid_amount`. A partial refund converts back, rounding down. If the payer has no held-country account in `paid_currency`, the refund goes through `sys:fx_out` and a payout to the payer's phone.

### Staged job

A job is a list of `job_stages`; in held mode each stage becomes an escrow (`escrows.stage_id`). Postings are exactly the escrow ones above, one stage at a time. Hooks in `modules/jobs.js` move the stage status (`funded`, `paid`, `disputed`, back to `planned` on refund or cancel). Marking a stage done sets `escrows.auto_release_at = now + AUTO_RELEASE_DAYS`.

### Protected order paid by collection

Fatou sells a dress for 12 500 F CFA; the buyer pays from the link with mobile money (`orderOps.payByCollection`). Webhook → `collectionHandlers.order`:

| Step | Entry | Postings (XOF) |
|---|---|---|
| Collection succeeds | `escrow_hold` (idem `order:<op>`) | `sys:rail` −12 500, `sys:escrow` +12 500 |
| Buyer confirms receipt (or auto-release after `ORDER_RELEASE_HOURS`) | `escrow_release` | `sys:escrow` −12 500, `W(Fatou)` +12 500 |
| A second payment for the same order | `collection_return` (idem `return:<op>`) | `sys:rail` −12 500, `sys:returns` +12 500 |
| … returned to the payer | `payout` → `payout_settled` | `sys:returns` −12 500, `sys:payout_pending` +12 500 → `sys:rail` +12 500 |

A buyer with an account pays the order code from the wallet (`wallet.pay`): `W(buyer)` −, `sys:escrow` +.

### Tontine round and payout

Three members, 10 000 F CFA each, monthly. Each group has its own pot `tontine:<id>` / `pot`.

| Step | Entry | Postings (XOF) |
|---|---|---|
| Member with an account contributes | `tontine_in` | `W(member)` −10 000, `pot` +10 000 |
| Member without the app pays from the link | `tontine_in` | `sys:rail` −10 000, `pot` +10 000 |
| Third contribution completes the round | `tontine_out` | `pot` −30 000, `W(receiver)` +30 000 (or a payout if the receiver has no account) |

The receiver is the member whose drawn `position` equals the round. `tontine_out` is exempt from the balance cap. A late or duplicate collection is returned through `returns` as for orders.

### Remittance with fee

Ousmane sends 100 € to "Tonton Alpha" in Guinea (no account). Fee: `PRICING.remitFee.EUR` = 150 cents × `remitFeeByLevel[level]` (1, 1, 0.5, 0 for reputation levels 0–3).

| Step | Entry | EUR | GNF |
|---|---|---|---|
| Fee | `remit_fee` | `W(Ousmane)` −150, `sys:fees` +150 | |
| Debit | `remit` | `W(Ousmane)` −10 000, `sys:remit_transit` +10 000 | |
| Convert | `remit` | `sys:remit_transit` −10 000, `sys:fx` +10 000 | `sys:fx` −940 000, `sys:fx_out` +940 000 |
| Pay out | `payout` | | `sys:fx_out` −940 000, `sys:payout_pending` +940 000 |
| Settled | `payout_settled` | | `sys:payout_pending` −940 000, `sys:rail` +940 000 |

Total debited 101,50 €; received 940 000 GNF. To a beneficiary with a held-country account (Mame Diarra, SN) the convert step credits her wallet directly: 250 € → `W` +163 989 F CFA. The `remittances` row stores amount, fee, received, `rate_e8`, `delivery` (`wallet` or `payout`) and `status` (`delivered` or `in_transit`; never updated afterwards).

### Agent cash-in, cash-out, commission

Only users with an active `agent` role, in held custody (`float.cashIn`, `float.cashOut`).

| Step | Entry | Postings (XOF) |
|---|---|---|
| Cash-in 75 000 (customer hands cash) | `cash_in` | `W(agent)` −75 000, `W(customer)` +75 000 |
| Cash-out with the customer's 8-digit code | `cash_out` | `W(customer)` −75 000, `W(agent)` +75 000 |
| Commission settlement (scheduled job) | `commission` (idem `commission:<accrual>`) | `sys:commissions` −375, `W(agent)` +375 |

Each operation accrues `round(amount × 50 / 10 000)` in `commission_accruals` (`accrued`). After 24 hours the scheduler pays it, unless the same agent did the opposite operation with the same customer within 24 hours of it: then it is `withheld` and the op `flagged`.

### Manual adjustment

Proposed by one admin, approved by another (`POST /api/admin/adjustments`, `/approve`). Amount is signed minor units.

| Entry `adjustment` (idem `adjustment:<id>`) | EUR |
|---|---|
| `sys:adjustments` | −250 |
| `W(user)` | +250 |

A negative adjustment larger than the balance fails with `Solde insuffisant`.

### Dispute split

Escrow 60 000 F CFA, disputed, resolved `split` with `payeeAmount` 20 000 (payee without account):

| Entry | Postings (XOF) |
|---|---|
| `escrow_release` path (payout) | `sys:escrow` −20 000, `sys:payout_pending` +20 000 → settled to `sys:rail` |
| `escrow_refund` | `sys:escrow` −40 000, `W(payer)` +40 000 |

Payer: 100 000 − 60 000 + 40 000 = 80 000. `release` and `refund` outcomes post the release or refund rows above for the full amount.

## Reconciliation and coverage

Both run hourly in `checkLedger()` (`server/scheduler.js`) and on every `GET /api/admin/overview`. A failure logs `LEDGER ALERT` and sends an in-app message to every active admin (at most once per admin per hour).

**Reconciliation** (`reconcile()` in `ledger.js`): any account whose cached `balance` differs from the sum of its postings. Expected result: no rows.

**Coverage ("safeguarding")** (`safeguarding()` in `admin.js`), per currency:

- `owed` = sum of balances of every non-system account (user wallets and tontine pots) **plus** system `escrow`, `payout_pending`, `returns`, `remit_transit`, `fx_out`.
- `held_at_partner` = minus the sum of system `rail`, `fx`, `adjustments`, `commissions`.
- `ok` when `owed ≤ held_at_partner`.

Read it carefully. Every entry balances per currency, so all accounts of a currency always sum to zero. The only account kind in neither list is `fees`, so `held_at_partner − owed = fees` by construction. The check is therefore an internal consistency check: it fails only if the ledger itself is broken (unbalanced data written outside `post()`, or a new account kind not added to either list). It does **not** compare against money actually held at the partner. That requires importing the partner's statement or balance per currency and comparing it with `-rail` (and the FX settlement), which is **not implemented** ([partner-integration.md](partner-integration.md)).

The tests (`healthy()` in `server/test/helpers.js`) assert all three after every money scenario: reconcile empty, each currency sums to zero, coverage ok.
