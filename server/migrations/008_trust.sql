-- Trust badges are private by default; a person may choose to show them to the people they deal with (public link pages).
ALTER TABLE users ADD COLUMN share_badges BOOLEAN NOT NULL DEFAULT false;
