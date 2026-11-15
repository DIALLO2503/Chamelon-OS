-- Which version of the terms and privacy notice the user accepted at sign-up, and when.
ALTER TABLE users ADD COLUMN terms_version TEXT, ADD COLUMN terms_accepted_at TIMESTAMPTZ;
