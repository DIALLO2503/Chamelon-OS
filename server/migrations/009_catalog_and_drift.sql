-- Runtime catalog: each version is an overlay on top of the catalog in code (server/catalog.js), proposed by one admin
-- and approved by another. Exactly one version is active at a time; superseded versions stay for history and rollback.
CREATE TABLE catalog_versions (
  id BIGSERIAL PRIMARY KEY,
  overlay JSONB NOT NULL, note TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'superseded', 'rejected')),
  proposed_by UUID REFERENCES users(id), approved_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), activated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX catalog_one_active ON catalog_versions ((true)) WHERE status = 'active';

-- Profile changes (drift accepted, or chosen by the person), for history and the 30-day cooldown.
CREATE TABLE persona_changes (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id),
  from_persona TEXT NOT NULL, to_persona TEXT NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('drift', 'choice', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX persona_changes_user ON persona_changes (user_id, created_at DESC);
