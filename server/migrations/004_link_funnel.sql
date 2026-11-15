-- Whether the person who was sent a link opened it and acted on it: the pilot's main measure.
ALTER TABLE links ADD COLUMN first_opened_at TIMESTAMPTZ, ADD COLUMN opens INT NOT NULL DEFAULT 0, ADD COLUMN first_acted_at TIMESTAMPTZ;
