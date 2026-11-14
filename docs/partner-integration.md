# Partner integration: what going live requires

A checklist for a licensed partner's engineer or a due-diligence reviewer. The partner holds the funds; Nexus is the front end and a shadow ledger. Code: `server/rails.js`, `server/config.js`, `server/auth.js`.

Related: [money.md](money.md), [custody-stages.md](custody-stages.md#switching-a-country), [security.md](security.md).

## Checklist

| # | Item | Status |
|---|---|---|
| 1 | Contract: partner holds funds in safeguarded accounts; licence covers the countries, products (wallet, escrow holds of weeks to months, tontine pots) and corridors | Not signed |
| 2 | Payment adapter matched to the partner's real API (below) | Generic HTTP adapter exists, untested against a real partner |
| 3 | Webhook format and signature agreed | Nexus format defined (below) |
| 4 | Status query / polling for operations without webhook | Not implemented |
| 5 | Daily statement import and match against `sys:rail` per currency | Not implemented |
| 6 | Rates and fees from partner quotes, quote id stored | Static `FX_E8_PER_EUR` and `PRICING` |
| 7 | KYC: partner or vendor onboarding writes `users.kyc_level` | Sandbox one-tap or admin only |
| 8 | Tier limits from the partner's rules in `REGIONS[id].limits` | Placeholders |
| 9 | Sanctions/PEP screening at onboarding and on payouts; monitoring | Not implemented |
| 10 | SMS for login codes (`issueOtp`) | Twilio adapter implemented; needs an account and a registered sender per country |
| 11 | WhatsApp/SMS notifications (`notifier.send`) | Twilio adapter implemented; needs a WhatsApp Business sender and approved templates |
| 12 | Agent network provisioning (KYB) feeding the `agent` role | Manual admin approval |
| 13 | Data processing agreement, residency, retention | Not decided |
| 14 | Per-country provider routing (one adapter per partner or rail) | One global adapter |

## The PaymentProvider interface

`provider` in `server/rails.js` is chosen by `PAYMENT_PROVIDER` (`sandbox` or `partner`). An adapter is an object:

```js
{
  name: 'partner',
  async payout(op)  { /* … */ return { providerRef } },   // money out to op.phone
  async collect(op) { /* … */ return { providerRef } },   // money in from op.phone (payer approves on their phone)
}
```

`op` is a `provider_ops` row: `{ id, kind ('payout'|'collection'), status, amount, currency, phone, user_id, party_id, purpose, provider_ref }`. `amount` is an integer in minor units of `currency` (XOF and GNF have no decimals). For bill payments `phone` is a pseudo address `biller:<name>:<reference>`.

The current `partnerProvider`:

| Call | Request | Expected response |
|---|---|---|
| `POST {PARTNER_BASE_URL}/payouts` | JSON `{ reference: op.id, amount, currency, phone }`; headers `Authorization: Bearer {PARTNER_API_KEY}`, `Idempotency-Key: op.id`; 15 s timeout | 2xx JSON with `id` (stored as `provider_ref`) |
| `POST {PARTNER_BASE_URL}/collections` | same | same |

Any non-2xx or timeout throws; the outbox retries with backoff up to 8 attempts ([operations.md](operations.md#outbox-and-retries)). **Idempotency reference:** `op.id` (a UUID) is both `reference` and `Idempotency-Key`; the partner must treat a repeated key as the same operation. Nexus calls the provider only from the outbox, after the deciding transaction committed; a quote never calls it.

### Collections vs payouts

| | Collection | Payout |
|---|---|---|
| Direction | Payer's mobile money → partner | Partner → recipient's mobile money (or biller) |
| Started by | `startCollection` (top-up, link payments for escrow, job stage, order, tontine) | `startPayout` (withdraw, bill, invoice, release to a non-user, remittance to a non-user, refunds, returns) |
| Ledger at start | Nothing | Source debited into `sys:payout_pending` |
| On `…succeeded` | `collectionHandlers[purpose.type]` credits from `sys:rail` (`topup`, `escrow_fund`, `order`, `tontine`) | `payout_pending` → `sys:rail` |
| On any other type | Operation marked `failed`, nothing posted | Reversed: `payout_pending` → source account |
| Late or duplicate | Returned to the payer via `sys:returns` and a payout | — |

### Statuses

`provider_ops.status`: `pending` → `succeeded` or `failed`. Only `pending` operations react to webhooks; later events return `{ ignored: '<status>' }`. A success followed by a reversal at the partner (chargeback, recall) has no handling: **not implemented**.

## Webhook

`POST {PUBLIC_URL}/api/webhooks/provider`.

- Raw body up to 64 kB, header `x-signature` = lowercase hex of HMAC-SHA256(raw body, `PARTNER_WEBHOOK_SECRET`).
- Body: `{ "id": "<unique event id>", "type": "payout.succeeded" | "collection.succeeded" | "<kind>.failed", "providerRef": "<the id returned at creation>", "amount": <integer minor units>, "currency": "XOF" }`. Any `type` not ending in `.succeeded` is treated as a failure.
- Processing in one transaction: insert `webhook_events(event_id)` (duplicate → `{ duplicate: true }`), lock the operation by `providerRef`, check `amount` and `currency` equal the operation (else 422), set the status, post.
- Responses: 200 `{ ok: true }`, `{ duplicate: true }`, `{ ignored }`; 401 bad signature; 404 unknown `providerRef`; 422 mismatch; 400/500 on a failing business rule or a non-JSON body. On any non-2xx nothing is stored, so the partner should retry.
- Ordering caveat: `provider_ref` is saved after the create call returns. A webhook arriving before that gets 404 and must be retried.
- No timestamp or nonce in the signature; replays are absorbed by the event id.

The sandbox adapter returns `SBX-P-…`/`SBX-C-…` refs and posts a signed `…succeeded` webhook to itself after 400 ms (`sandboxSettle`), except when `NEXUS_NO_AUTO_SETTLE` is set or in `test` without `SANDBOX_AUTO_SETTLE`.

## What Nexus stores

| Table | Content |
|---|---|
| `provider_ops` | One row per collection or payout: kind, status, amount, currency, phone, user, party, `purpose` (JSON: type and business ids, `source` account for payouts), `provider_ref`, timestamps |
| `outbox` | The pending call, attempts, last error |
| `webhook_events` | Every accepted event id with its full payload |
| `entries`, `postings` | The ledger effect, with `idem` keys `topup:`, `settle:`, `reverse:`, `fund:`, `order:`, `return:` + operation id |

## SMS hook

`issueOtp(phone, ip)` in `server/auth.js` stores the hashed code, then calls `sendSms` in `server/messaging.js` whenever `SMS_PROVIDER` is set (always in live). The adapter posts to Twilio's Messages API with `TWILIO_ACCOUNT_SID` and `SMS_API_KEY` (the auth token), from `SMS_FROM` or through `TWILIO_MESSAGING_SERVICE_SID`. A refused or timed-out send returns a 502 to the caller. Outside live the code is also returned in the response.

Before a pilot: register the sender in each country (alphanumeric sender IDs need pre-registration in Morocco and Senegal, among others; a messaging service lets Twilio pick the right sender per destination), and check the per-message price per country, since login codes are the main recurring messaging cost.

## Notification hook

`notify()` writes `notifications`. For a party with an account it is `inapp`/`delivered`; for a party without one, `whatsapp`/`pending` plus an outbox `notify.send`. The worker calls `notifier.send(notification, phone)`: with `NOTIFIER=log` it logs and marks `sent`. Otherwise it calls `deliver` in `server/messaging.js` and stores the channel actually used in `notifications.channel`:

- `NOTIFIER=sms`: the text and the link go by SMS.
- `NOTIFIER=whatsapp`: if `WHATSAPP_TEMPLATES` maps `notifications.template` to a Twilio Content SID, the message goes on WhatsApp from `WHATSAPP_FROM` with `{{1}}` = text and `{{2}}` = link; any other template falls back to SMS.

WhatsApp only lets a business open a conversation with a template approved by Meta, so each template must be created in Twilio's Content Template Builder with those two variables and approved before it is added to `WHATSAPP_TEMPLATES`. Recipient opt-in is **not recorded**.

## KYC levels

`users.kyc_level`: 0 phone verified, 1 identity verified, 2 enhanced. Written today by `wallet.verify` (sandbox only, audit `kyc.level` with `source: 'sandbox'`) and `POST /api/admin/users/:id/kyc` (audit with reason). A vendor or partner result should set the level in the same way and keep the vendor reference in `audit_events.data`; a callback endpoint for it is **not implemented**. Limits per level: [money.md](money.md#limits-per-kyc-level).

## Rates and fees

`FX_E8_PER_EUR` and `PRICING` in `server/catalog.js` are static. The quote/confirm design already re-plans at confirmation and refuses if the review changed, so a live rate source can be called in `plan()`; the remittance review exposes `rate` and `remittances.rate_e8` stores it. Spread, quote id and FX revaluation are **not implemented**.

## Sandbox-only behaviour and where to change it

| Behaviour | File |
|---|---|
| Simulated partner refs and self-sent webhook | `server/rails.js` (`sandboxProvider`, `sandboxSettle`) |
| Settling in seed and tests | `simulateSettle` in `server/rails.js`; `server/seed.js`; `settleAll` in `server/test/helpers.js` |
| Public webhook secret `sandbox-webhook-secret` | `server/config.js` |
| Generated `JWT_SECRET`/`LINK_SECRET` in `.local/` | `server/config.js` |
| Login code returned to the client | `server/auth.js` (`issueOtp`, `/otp`), `server/public.js` (`/:token/otp`); shown by `src/Auth.jsx`, `src/public/PublicPage.jsx` |
| Higher OTP caps (50/day) | `CAPS` in `server/auth.js` |
| Demo account list and PIN | `/api/config/sandbox` in `server/index.js`; `server/seed.js` |
| One-tap identity verification | `wallet.verify` in `server/modules/wallet.js` |
| Notifications only logged | `notifier` in `server/rails.js` (`NOTIFIER=log`) |
| Login code still returned to the client when an SMS provider is set | `issueOtp` in `server/auth.js` |
| Bill payment simulated (payout to `biller:…`) | `wallet.bill` in `server/modules/wallet.js` |
| Static rates and fees, labelled "Taux du jour (bac à sable)" | `server/catalog.js`, `server/modules/remit.js` |
| Placeholder limits | `REGIONS[id].limits` in `server/catalog.js` |
| Sandbox notices in forms (top-up, bill, invoice pay) | `server/modules/wallet.js`, `server/modules/commerce.js` |
| Rate limits disabled | `server/index.js` (`NEXUS_ENV=test` only) |
