-- When the user last replaced a forgotten secret code. Money actions are held for a period after it (PIN_RESET_HOLD_HOURS).
ALTER TABLE users ADD COLUMN pin_reset_at TIMESTAMPTZ;
