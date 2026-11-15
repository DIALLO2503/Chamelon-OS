-- A user asked for their account to be closed; an admin handles it (docs/operations.md).
ALTER TABLE users ADD COLUMN closure_requested_at TIMESTAMPTZ;
