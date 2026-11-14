-- Identity and access
CREATE TABLE users (
  id UUID PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  region TEXT NOT NULL, persona TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'fr',
  kyc_level INT NOT NULL DEFAULT 0, pin_hash TEXT, pin_failures INT NOT NULL DEFAULT 0, pin_locked_until TIMESTAMPTZ,
  frozen BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE roles (
  user_id UUID NOT NULL REFERENCES users(id), role TEXT NOT NULL, status TEXT NOT NULL,
  granted_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, role)
);
CREATE TABLE sessions (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), refresh_hash TEXT NOT NULL,
  user_agent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ
);
CREATE TABLE otps (phone TEXT PRIMARY KEY, hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, attempts INT NOT NULL DEFAULT 0);
CREATE TABLE otp_events (id BIGSERIAL PRIMARY KEY, phone TEXT NOT NULL, kind TEXT NOT NULL, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX otp_events_phone ON otp_events (phone, created_at);

-- People Nexus deals with, with or without an account. A party gains a user_id when that phone signs up.
CREATE TABLE parties (
  id UUID PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL, user_id UUID UNIQUE REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ledger: balances are a cache of postings; postings and entries are append-only.
CREATE TABLE accounts (
  id UUID PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, currency TEXT NOT NULL,
  balance BIGINT NOT NULL DEFAULT 0, floor BIGINT,
  UNIQUE (owner, kind, currency), CHECK (floor IS NULL OR balance >= floor)
);
CREATE TABLE entries (id UUID PRIMARY KEY, kind TEXT NOT NULL, idem TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE postings (
  id BIGSERIAL PRIMARY KEY, entry_id UUID NOT NULL REFERENCES entries(id), account_id UUID NOT NULL REFERENCES accounts(id),
  amount BIGINT NOT NULL CHECK (amount <> 0), title TEXT, cp_party UUID REFERENCES parties(id), ref TEXT, icon TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX postings_account ON postings (account_id, id);
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON postings FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON entries FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Requests and quotes
CREATE TABLE idempotency (
  user_id UUID NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, key)
);
CREATE TABLE intents (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), module TEXT NOT NULL, action TEXT NOT NULL, row_ref TEXT,
  input JSONB NOT NULL, review JSONB NOT NULL, review_hash TEXT NOT NULL, status TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL,
  object_type TEXT, object_id TEXT, data JSONB, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_actor ON audit_events (actor_id, action, created_at);

-- External rails
CREATE TABLE outbox (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, payload JSONB NOT NULL, idem TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0, next_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_due ON outbox (status, next_at);
CREATE TABLE provider_ops (
  id UUID PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, amount BIGINT NOT NULL, currency TEXT NOT NULL,
  phone TEXT, user_id UUID REFERENCES users(id), party_id UUID REFERENCES parties(id), purpose JSONB NOT NULL,
  provider_ref TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, payload JSONB NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- Counterparty access without an install
CREATE TABLE links (
  id UUID PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, ref_id UUID NOT NULL, party_id UUID REFERENCES parties(id),
  expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE uploads (
  id UUID PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, path TEXT NOT NULL, mime TEXT NOT NULL,
  size INT NOT NULL, sha256 TEXT NOT NULL, meta JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id BIGSERIAL PRIMARY KEY, user_id UUID REFERENCES users(id), party_id UUID REFERENCES parties(id), channel TEXT NOT NULL,
  template TEXT NOT NULL, text TEXT NOT NULL, link TEXT, status TEXT NOT NULL DEFAULT 'pending', dedupe TEXT UNIQUE,
  read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

-- Payments made outside Nexus (custody stage 1): one side records, the other confirms.
CREATE TABLE recorded_payments (
  id UUID PRIMARY KEY, payer_party UUID NOT NULL REFERENCES parties(id), payee_party UUID NOT NULL REFERENCES parties(id),
  amount BIGINT NOT NULL CHECK (amount > 0), currency TEXT NOT NULL, purpose TEXT NOT NULL, ref TEXT,
  recorded_by UUID NOT NULL REFERENCES parties(id), status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), confirmed_at TIMESTAMPTZ
);
CREATE INDEX recorded_payer ON recorded_payments (payer_party, created_at DESC);
CREATE INDEX recorded_payee ON recorded_payments (payee_party, created_at DESC);

-- Savings groups
CREATE TABLE tontines (
  id UUID PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, amount BIGINT NOT NULL, organiser_id UUID NOT NULL REFERENCES users(id),
  frequency TEXT NOT NULL, size INT NOT NULL, round INT NOT NULL DEFAULT 1, status TEXT NOT NULL, mode TEXT NOT NULL,
  next_due DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tontine_members (
  tontine_id UUID NOT NULL REFERENCES tontines(id), party_id UUID NOT NULL REFERENCES parties(id), position INT,
  accepted_at TIMESTAMPTZ, PRIMARY KEY (tontine_id, party_id)
);
CREATE TABLE tontine_contribs (
  tontine_id UUID NOT NULL, round INT NOT NULL, party_id UUID NOT NULL, status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), confirmed_at TIMESTAMPTZ, PRIMARY KEY (tontine_id, round, party_id)
);

-- Escrow, staged jobs and disputes
CREATE TABLE escrows (
  id UUID PRIMARY KEY, payer_party UUID NOT NULL REFERENCES parties(id), payee_party UUID NOT NULL REFERENCES parties(id),
  currency TEXT NOT NULL, amount BIGINT NOT NULL, paid_currency TEXT, paid_amount BIGINT, title TEXT NOT NULL,
  status TEXT NOT NULL, mode TEXT NOT NULL, stage_id UUID, order_id UUID, release_to TEXT, auto_release_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE jobs (
  id UUID PRIMARY KEY, artisan_party UUID NOT NULL REFERENCES parties(id), client_party UUID NOT NULL REFERENCES parties(id),
  created_by UUID NOT NULL REFERENCES users(id), title TEXT NOT NULL, currency TEXT NOT NULL, mode TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE job_stages (
  id UUID PRIMARY KEY, job_id UUID NOT NULL REFERENCES jobs(id), position INT NOT NULL, title TEXT NOT NULL, amount BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned', escrow_id UUID, proof UUID[] NOT NULL DEFAULT '{}', done_at TIMESTAMPTZ
);
CREATE TABLE disputes (
  id UUID PRIMARY KEY, escrow_id UUID NOT NULL REFERENCES escrows(id), opened_by UUID NOT NULL REFERENCES parties(id), reason TEXT NOT NULL,
  status TEXT NOT NULL, proposal JSONB, proposed_by UUID, resolution JSONB, resolved_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ
);
CREATE TABLE dispute_evidence (
  id UUID PRIMARY KEY, dispute_id UUID NOT NULL REFERENCES disputes(id), party_id UUID NOT NULL REFERENCES parties(id),
  text TEXT, upload_id UUID REFERENCES uploads(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE adjustments (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), amount BIGINT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
  proposed_by UUID NOT NULL, approved_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Remittances and family
CREATE TABLE beneficiaries (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), party_id UUID NOT NULL REFERENCES parties(id), region TEXT NOT NULL,
  name TEXT NOT NULL, relation TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (user_id, party_id)
);
CREATE TABLE remittances (
  id UUID PRIMARY KEY, sender_id UUID NOT NULL REFERENCES users(id), party_id UUID NOT NULL REFERENCES parties(id),
  currency TEXT NOT NULL, amount BIGINT NOT NULL, fee BIGINT NOT NULL, to_currency TEXT NOT NULL, received BIGINT NOT NULL,
  rate_e8 BIGINT NOT NULL, delivery TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE remit_schedules (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), beneficiary_id UUID NOT NULL REFERENCES beneficiaries(id),
  amount BIGINT NOT NULL, day INT NOT NULL, next_run DATE NOT NULL, note TEXT
);

-- Commerce and records
CREATE TABLE orders (
  id UUID PRIMARY KEY, seller_id UUID NOT NULL REFERENCES users(id), item TEXT NOT NULL, amount BIGINT NOT NULL, currency TEXT NOT NULL,
  buyer_party UUID REFERENCES parties(id), customer_name TEXT NOT NULL, code TEXT UNIQUE NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, paid_via TEXT, escrow_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ
);
CREATE TABLE customers (
  id UUID PRIMARY KEY, shop_id UUID NOT NULL REFERENCES users(id), name TEXT NOT NULL, party_id UUID REFERENCES parties(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE credit_entries (
  id UUID PRIMARY KEY, shop_id UUID NOT NULL REFERENCES users(id), customer_id UUID NOT NULL REFERENCES customers(id),
  amount BIGINT NOT NULL, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE invoices (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), supplier TEXT NOT NULL, amount BIGINT NOT NULL, due_date DATE,
  status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ
);
CREATE TABLE shift_items (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), kind TEXT NOT NULL, label TEXT NOT NULL, amount BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE budgets (user_id UUID PRIMARY KEY REFERENCES users(id), total BIGINT NOT NULL);
CREATE TABLE expenses (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), category TEXT NOT NULL, amount BIGINT NOT NULL, label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agents
CREATE TABLE cash_codes (
  id UUID PRIMARY KEY, customer_id UUID NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL, amount BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, agent_id UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE cash_ops (
  id UUID PRIMARY KEY, agent_id UUID NOT NULL REFERENCES users(id), customer_id UUID NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, amount BIGINT NOT NULL, flagged BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE commission_accruals (
  id UUID PRIMARY KEY, agent_id UUID NOT NULL REFERENCES users(id), op_id UUID NOT NULL REFERENCES cash_ops(id), amount BIGINT NOT NULL,
  status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
