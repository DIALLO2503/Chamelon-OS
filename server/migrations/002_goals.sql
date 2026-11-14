-- A user's own monthly income target ("pain du mois"), shown as a progress bar.
CREATE TABLE goals (user_id UUID PRIMARY KEY REFERENCES users(id), amount BIGINT NOT NULL CHECK (amount > 0));
