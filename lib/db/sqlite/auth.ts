import type Database from "better-sqlite3";
import type {
  AuthRepo,
  AuthStatePatch,
  AuthStateRow,
  PasskeyInsert,
  PasskeyRow,
  SessionRow,
} from "../../db";

interface PasskeyDbRow {
  id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number | null;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

function rowToPasskey(r: PasskeyDbRow): PasskeyRow {
  let transports: string[] | null = null;
  if (r.transports) {
    try {
      const parsed = JSON.parse(r.transports);
      if (Array.isArray(parsed)) transports = parsed.filter((t) => typeof t === "string");
    } catch {
      transports = null;
    }
  }
  return {
    id: r.id,
    public_key: Buffer.from(r.public_key),
    counter: r.counter,
    transports,
    device_type: r.device_type ?? null,
    backed_up: r.backed_up === null ? null : r.backed_up === 1,
    label: r.label ?? null,
    created_at: r.created_at,
    last_used_at: r.last_used_at ?? null,
  };
}

export function authRepo(db: Database.Database): AuthRepo {
  // sessions
  const createSessionStmt = db.prepare(`
    INSERT INTO sessions (id, created_at, last_seen_at, expires_at)
    VALUES (@id, @created_at, @last_seen_at, @expires_at)
  `);
  const getSessionStmt = db.prepare(
    `SELECT id, created_at, last_seen_at, expires_at FROM sessions WHERE id = ?`
  );
  const touchSessionStmt = db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`);
  const deleteSessionStmt = db.prepare(`DELETE FROM sessions WHERE id = ?`);
  const deleteAllSessionsStmt = db.prepare(`DELETE FROM sessions`);
  const purgeSessionsStmt = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`);

  // auth_state
  const getAuthStateStmt = db.prepare(
    `SELECT totp_secret_ct, totp_confirmed_at, totp_last_step, webauthn_user_id, updated_at
     FROM auth_state WHERE id = 1`
  );
  const upsertAuthStateStmt = db.prepare(`
    INSERT INTO auth_state (id, totp_secret_ct, totp_confirmed_at, totp_last_step, webauthn_user_id, updated_at)
    VALUES (1, @totp_secret_ct, @totp_confirmed_at, @totp_last_step, @webauthn_user_id, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      totp_secret_ct = excluded.totp_secret_ct,
      totp_confirmed_at = excluded.totp_confirmed_at,
      totp_last_step = excluded.totp_last_step,
      webauthn_user_id = excluded.webauthn_user_id,
      updated_at = excluded.updated_at
  `);
  const upsertAuthState = db.transaction((patch: AuthStatePatch): AuthStateRow => {
    const cur = (getAuthStateStmt.get() as AuthStateRow | undefined) ?? {
      totp_secret_ct: null,
      totp_confirmed_at: null,
      totp_last_step: null,
      webauthn_user_id: null,
      updated_at: "",
    };
    const next: AuthStateRow = {
      totp_secret_ct: patch.totp_secret_ct !== undefined ? patch.totp_secret_ct : cur.totp_secret_ct,
      totp_confirmed_at:
        patch.totp_confirmed_at !== undefined ? patch.totp_confirmed_at : cur.totp_confirmed_at,
      totp_last_step: patch.totp_last_step !== undefined ? patch.totp_last_step : cur.totp_last_step,
      webauthn_user_id:
        patch.webauthn_user_id !== undefined ? patch.webauthn_user_id : cur.webauthn_user_id,
      updated_at: new Date().toISOString(),
    };
    upsertAuthStateStmt.run(next);
    return next;
  });

  // passkeys
  const PK_COLS =
    "id, public_key, counter, transports, device_type, backed_up, label, created_at, last_used_at";
  const listPasskeysStmt = db.prepare(`SELECT ${PK_COLS} FROM passkeys ORDER BY created_at ASC`);
  const getPasskeyStmt = db.prepare(`SELECT ${PK_COLS} FROM passkeys WHERE id = ?`);
  const insertPasskeyStmt = db.prepare(`
    INSERT INTO passkeys (id, public_key, counter, transports, device_type, backed_up, label, created_at, last_used_at)
    VALUES (@id, @public_key, @counter, @transports, @device_type, @backed_up, @label, @created_at, NULL)
  `);
  const updateCounterStmt = db.prepare(
    `UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?`
  );
  const deletePasskeyStmt = db.prepare(`DELETE FROM passkeys WHERE id = ?`);

  // recovery codes
  const deleteCodesStmt = db.prepare(`DELETE FROM recovery_codes`);
  const insertCodeStmt = db.prepare(
    `INSERT INTO recovery_codes (code_hash, used_at, created_at) VALUES (?, NULL, ?)`
  );
  const consumeCodeStmt = db.prepare(
    `UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`
  );
  const countCodesStmt = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS remaining
     FROM recovery_codes`
  );
  const replaceCodes = db.transaction((hashes: string[]) => {
    deleteCodesStmt.run();
    const now = new Date().toISOString();
    for (const h of hashes) insertCodeStmt.run(h, now);
  });

  // challenges
  const createChallengeStmt = db.prepare(`
    INSERT INTO auth_challenges (id, kind, challenge, expires_at, consumed_at)
    VALUES (@id, @kind, @challenge, @expires_at, NULL)
  `);
  const getChallengeStmt = db.prepare(
    `SELECT challenge FROM auth_challenges
     WHERE id = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?`
  );
  const consumeChallengeStmt = db.prepare(
    `UPDATE auth_challenges SET consumed_at = ?
     WHERE id = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?`
  );
  const consumeChallenge = db.transaction((id: string, kind: string, now: string): string | null => {
    const row = getChallengeStmt.get(id, kind, now) as { challenge: string } | undefined;
    if (!row) return null;
    const res = consumeChallengeStmt.run(now, id, kind, now);
    return res.changes === 1 ? row.challenge : null;
  });
  const purgeChallengesStmt = db.prepare(
    `DELETE FROM auth_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL`
  );

  return {
    async createSession(row: SessionRow) {
      createSessionStmt.run(row);
    },
    async getSession(id) {
      const r = getSessionStmt.get(id) as SessionRow | undefined;
      return r ?? null;
    },
    async touchSession(id, last_seen_at) {
      touchSessionStmt.run(last_seen_at, id);
    },
    async deleteSession(id) {
      deleteSessionStmt.run(id);
    },
    async deleteAllSessions() {
      return deleteAllSessionsStmt.run().changes;
    },
    async purgeExpiredSessions(now) {
      return purgeSessionsStmt.run(now).changes;
    },

    async getAuthState() {
      const r = getAuthStateStmt.get() as AuthStateRow | undefined;
      return r ?? null;
    },
    async upsertAuthState(patch) {
      return upsertAuthState(patch);
    },

    async listPasskeys() {
      return (listPasskeysStmt.all() as PasskeyDbRow[]).map(rowToPasskey);
    },
    async getPasskey(id) {
      const r = getPasskeyStmt.get(id) as PasskeyDbRow | undefined;
      return r ? rowToPasskey(r) : null;
    },
    async insertPasskey(row: PasskeyInsert) {
      insertPasskeyStmt.run({
        id: row.id,
        public_key: row.public_key,
        counter: row.counter,
        transports: row.transports ? JSON.stringify(row.transports) : null,
        device_type: row.device_type ?? null,
        backed_up: row.backed_up === null ? null : row.backed_up ? 1 : 0,
        label: row.label ?? null,
        created_at: new Date().toISOString(),
      });
    },
    async updatePasskeyCounter(id, counter, last_used_at) {
      updateCounterStmt.run(counter, last_used_at, id);
    },
    async deletePasskey(id) {
      deletePasskeyStmt.run(id);
    },

    async replaceRecoveryCodes(hashes) {
      replaceCodes(hashes);
    },
    async consumeRecoveryCode(hash) {
      return consumeCodeStmt.run(new Date().toISOString(), hash).changes === 1;
    },
    async countRecoveryCodes() {
      const r = countCodesStmt.get() as { total: number; remaining: number | null };
      return { total: r.total, remaining: r.remaining ?? 0 };
    },

    async createChallenge(row) {
      createChallengeStmt.run(row);
    },
    async consumeChallenge(id, kind, now) {
      return consumeChallenge(id, kind, now);
    },
    async purgeChallenges(now) {
      return purgeChallengesStmt.run(now).changes;
    },
  };
}
