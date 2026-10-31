-- WP2: auth. Server-side sessions, enrolled factors, recovery codes and
-- WebAuthn challenges. No secrets in the clear: sessions.id is sha256 of the
-- cookie token, totp_secret_ct is AES-256-GCM (AAD "auth_state:totp"),
-- recovery_codes.code_hash is sha256 of the normalised code.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  totp_secret_ct TEXT,
  totp_confirmed_at TEXT,
  totp_last_step INTEGER,
  webauthn_user_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT,
  device_type TEXT,
  backed_up INTEGER,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT UNIQUE NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reg', 'auth')),
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
