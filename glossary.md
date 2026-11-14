# Glossary

Product terms appear in French in the interface; their code identifiers are in backticks. Related: [catalog.md](catalog.md), [custody-stages.md](custody-stages.md).

## Domain and product terms

| Term | Meaning |
|---|---|
| **Daret** | Moroccan name for a rotating savings group (tontine). `vocab.tontine` in MA. |
| **Natt** | Wolof name for the same in Senegal. `vocab.tontine` in SN. |
| **Tontine** | A group where each member pays a fixed amount every period and one member, in turn, receives the whole pot. Module `tontine`. |
| **Aman** | "Trust, safety" in Arabic/Darija; the Moroccan label for escrow. `vocab.escrow` in MA. Elsewhere "Séquestre". |
| **Séquestre / escrow** | Money held until the payer releases it or a rule does. Module `escrow`. |
| **Niya** | "Good faith, intention" in Darija; the Moroccan label for the reputation screen. `vocab.reputation` in MA. |
| **Zellij** | Moroccan mosaic tilework. The reputation screen draws one tile per kept commitment on a 6 × 6 zellij; levels are "Premières pièces", "Motif", "Rosace", "Zellij complet". Block type `zellij`. |
| **Maâllem** | Master craftsman in Morocco, typically in building trades. Persona `maallem`. |
| **Moul hanout** | Owner of a Moroccan corner shop. Persona `hanout`. |
| **Ouvrier, journalier** | Day labourer paid by the day; persona `ouvrier`, whose confirmed pay builds a record. |
| **Carnet (de crédit)** | The shop's book of what customers owe. Module `creditbook`. |
| **Pain du mois** | A user's own monthly income target (`goals` table, `wallet.goal`). |
| **Float** | E-money an agent holds to serve cash-in. Module `float`. |
| **Agent (mobile money)** | A shop approved to exchange cash for e-money. Persona `agent`, role `agent`. |
| **Diaspora / builder** | Someone abroad paying for a house or project back home. Persona `builder` (`jobRole: 'client'`). |
| **Chantier, étape** | A building job and one of its stages. Tables `jobs`, `job_stages`. |
| **Remittance (envoi au pays)** | Money sent to family in another country. Module `remit`; `remittances` table. |
| **Beneficiary (proche)** | A person a user sends to, saved with a display name. `beneficiaries`. |

## System terms

| Term | Meaning |
|---|---|
| **Region** | A country entry in `REGIONS` (MA, SN, GN, FR, AE): currency, dial code, custody, modules, profiles. |
| **Persona / profile** | A configured role inside a country (seller, driver…): navigation, quick actions, home widgets. |
| **Module** | A capability with a view, actions and widgets (`server/modules/*.js`). |
| **Vocabulary token** | `{tontine}`, `{escrow}`, `{reputation}` in labels, replaced per country. |
| **Custody stage** | Per country: `record` (no money through Nexus) or `held` (licensed partner holds funds). |
| **Mode** | The custody of one row (escrow, job, order, tontine): `recorded` or `held`, fixed at creation. |
| **Recorded payment** | A payment made outside Nexus, claimed by one side and confirmed or rejected by the other. `recorded_payments`. |
| **Intent** | A stored quote: the reviewed lines and their hash, confirmed by id with the PIN within 10 minutes. `intents`. |
| **Quote / review** | What the user sees before confirming: `review.lines` and `cta`. |
| **Plan / run** | A money action defines `plan` (quote + PIN); a record-keeping action defines `run` (direct). |
| **Party vs user** | A party is anyone identified by a phone (`parties`), with or without an account; a user has an account. A party gains `user_id` when its phone signs up. |
| **Counterparty** | The other side of a payment; in postings `cp_party`. |
| **Public link** | `PUBLIC_URL/l/<token>`: a page for a party without the app. View with the link; commit with an OTP. |
| **Corridor** | A country a sending country is allowed to send to (`corridors`). Only in held custody, only for remittances and escrow. |
| **Collection** | Money pulled from a payer's mobile money into the partner (`provider_ops.kind = 'collection'`). |
| **Payout** | Money pushed from the partner to a recipient's mobile money or a biller (`kind = 'payout'`). |
| **Provider / partner** | The licensed institution behind `held` custody; the adapter in `server/rails.js`. |
| **Outbox** | Table of external calls decided by committed transactions, run by a worker with retries. |
| **Webhook** | The partner's signed callback reporting an operation's result. |
| **Shadow ledger** | Nexus's double-entry record of funds the partner actually holds. |
| **Entry / posting** | One business event / one signed line of it on an account. |
| **Minor units** | Integer amounts in the smallest unit: cents for EUR, MAD, AED; units for XOF, GNF. |
| **Suspense account** | `payout_pending`: money sent out, not yet confirmed. |
| **System account** | An account owned by `system` (`rail`, `fx`, `escrow`, `fees`…). |
| **Coverage (safeguarding) check** | Hourly check that customer money owed is not more than what the ledger says the partner holds ([money.md](money.md#reconciliation-and-coverage)). |
| **Reconciliation** | Check that every cached balance equals the sum of its postings. |
| **KYC level** | 0 phone verified, 1 identity verified, 2 enhanced; selects the limits. |
| **Auto-release** | Silence means yes: a finished stage (7 days) or delivered order (72 h) pays out unless disputed. |
| **Two-person rule (4-eyes)** | Dispute decisions and adjustments need a proposer and a different approver. |
| **Adjustment** | A manual balance correction against `sys:adjustments`. |
| **Compare-and-set** | A status update that succeeds only if the row is still in the expected state (`transition()`). |
| **Idempotency key** | Client-chosen request id; a retry with the same key and content returns the first answer. |
| **Masked name** | "Fatou D.": first name and last initial, shown to anyone but the person. |
| **Cash code** | 8-digit one-time code a customer shows an agent to withdraw cash (15 minutes). |
| **Order code** | 10-character code a buyer with an account uses to pay an order (`wallet.pay`). |
| **Blocks** | Server-built screen parts (`balance`, `rows`, `feed`…) rendered by `src/ui/Blocks.jsx`. |
