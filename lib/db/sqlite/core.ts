import type Database from "better-sqlite3";
import type { CoreRepo } from "../../db";

export function coreRepo(db: Database.Database): CoreRepo {
  const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
  const setSettingStmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const appendLogStmt = db.prepare(`
    INSERT INTO security_log (at, event, item_id, outcome, detail)
    VALUES (@at, @event, @item_id, @outcome, @detail)
  `);

  return {
    async getSetting(key) {
      const r = getSettingStmt.get(key) as { value: string } | undefined;
      return r ? r.value : null;
    },
    async setSetting(key, value) {
      setSettingStmt.run(key, value, new Date().toISOString());
    },
    async appendSecurityLog(row) {
      appendLogStmt.run({
        at: row.at ?? new Date().toISOString(),
        event: row.event,
        item_id: row.item_id ?? null,
        outcome: row.outcome ?? null,
        detail: row.detail ?? null,
      });
    },
  };
}
