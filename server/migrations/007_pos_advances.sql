-- In-person collection ("Encaisser"): one row per sale. held: a collection request to the customer's mobile money (op_id).
-- record: a payment the customer confirms from a link or a scanned code (recorded_id).
CREATE TABLE pos_sales (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id),
  amount BIGINT NOT NULL CHECK (amount > 0), currency TEXT NOT NULL, label TEXT NOT NULL, customer_phone TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('collection', 'recorded')),
  op_id UUID REFERENCES provider_ops(id), recorded_id UUID REFERENCES recorded_payments(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ
);
CREATE INDEX pos_sales_user ON pos_sales (user_id, created_at DESC);

-- Earned-wage advances, funded by a licensed lender's credit line at the payment partner (system account "lender").
-- amount + fee is owed; repaid grows with each repayment until it reaches amount + fee.
CREATE TABLE advances (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), currency TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0), fee BIGINT NOT NULL CHECK (fee >= 0), repaid BIGINT NOT NULL DEFAULT 0 CHECK (repaid >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'repaid')),
  due_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), repaid_at TIMESTAMPTZ,
  CHECK (repaid <= amount + fee)
);
-- At most one advance outstanding per person.
CREATE UNIQUE INDEX advances_one_active ON advances (user_id) WHERE status = 'active';
