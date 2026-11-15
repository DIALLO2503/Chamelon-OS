-- Personal data out of the append-only ledger. A posting keeps only what the accounts need (amount, account, reference,
-- icon); its human label and counterparty move to posting_details, which can be erased (right to erasure, CNDP 09-08,
-- GDPR) without touching the ledger. Existing rows are moved once, the only time the append-only trigger is lifted.
CREATE TABLE posting_details (
  posting_id BIGINT PRIMARY KEY REFERENCES postings(id),
  title TEXT, cp_party UUID REFERENCES parties(id), erased_at TIMESTAMPTZ
);
CREATE INDEX posting_details_cp ON posting_details (cp_party);

ALTER TABLE postings DISABLE TRIGGER postings_append_only;
INSERT INTO posting_details (posting_id, title, cp_party)
  SELECT id, title, cp_party FROM postings WHERE title IS NOT NULL OR cp_party IS NOT NULL;
UPDATE postings SET title = NULL, cp_party = NULL WHERE title IS NOT NULL OR cp_party IS NOT NULL;
ALTER TABLE postings ENABLE TRIGGER postings_append_only;

-- Accounts erased at the person's request (after a closure request and a zero balance).
ALTER TABLE users ADD COLUMN erased_at TIMESTAMPTZ;
