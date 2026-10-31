-- WP4: per-item lifecycle status. Values: active | needs_relink | consent_required | revoke_failed.
-- last_error holds a provider error_code enum string only (never a message or body).
ALTER TABLE plaid_items ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE plaid_items ADD COLUMN last_error TEXT;
