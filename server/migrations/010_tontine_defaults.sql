-- A round closed by the organiser after the grace period: each member who did not pay is recorded as a default
-- (visible to the group, counted in their reputation). A group can also be dissolved (tontines.status = 'dissolved').
CREATE TABLE tontine_defaults (
  tontine_id UUID NOT NULL REFERENCES tontines(id), round INT NOT NULL, party_id UUID NOT NULL REFERENCES parties(id),
  amount BIGINT NOT NULL, currency TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), settled_at TIMESTAMPTZ,
  PRIMARY KEY (tontine_id, round, party_id)
);
