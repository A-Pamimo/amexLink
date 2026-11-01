-- WP6a: provider accounts and per-field provenance for the cards overview.
-- `accounts` rows are written only by the provider refresh path (lib/cards/refresh.ts) from an
-- explicit allowlist of provider fields; there is no client-writable path (SECURITY.md P-T1/P-T2).
-- `account_fields` holds one observation per (account, field, provider). `status` is one of
-- present | not_supplied | not_supported | consent_required | error; `error_code` is a provider
-- error_code enum string only (never a message or body). `value_json` is the JSON of the value.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES plaid_items(item_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  name TEXT,
  official_name TEXT,
  mask TEXT,
  type TEXT,
  subtype TEXT,
  iso_currency_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS accounts_item ON accounts(item_id);

CREATE TABLE IF NOT EXISTS account_fields (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  value_json TEXT,
  observed_at TEXT NOT NULL,
  error_code TEXT,
  PRIMARY KEY (account_id, field, provider)
);

-- Per-item refresh metadata. liabilities_status: ok | not_supported | consent_required | pending | error.
-- balance_source: realtime | cached | error.
ALTER TABLE plaid_items ADD COLUMN liabilities_status TEXT;
ALTER TABLE plaid_items ADD COLUMN balance_source TEXT;
ALTER TABLE plaid_items ADD COLUMN last_refreshed_at TEXT;
