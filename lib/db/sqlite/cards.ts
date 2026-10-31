import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { CardsRepo, ItemRefreshMeta } from "../../db";
import {
  FIELD_KEYS,
  type AccountRow,
  type CardRow,
  type FieldKey,
  type FieldObservation,
  type FieldStatus,
} from "../../providers/types";

interface FieldDbRow {
  account_id: string;
  field: string;
  status: string;
  value_json: string | null;
  observed_at: string;
  error_code: string | null;
}

interface JoinedAccountRow extends AccountRow {
  institution_name: string | null;
  item_status: string | null;
  last_synced_at: string | null;
  liabilities_status: string | null;
  balance_source: string | null;
  last_refreshed_at: string | null;
}

const FIELD_SET = new Set<string>(FIELD_KEYS);

function parseValue(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const ACCOUNT_COLUMNS =
  "id, item_id, provider, provider_account_id, name, official_name, mask, type, subtype, iso_currency_code, created_at, updated_at";

export function cardsRepo(db: Database.Database): CardsRepo {
  // `RETURNING id` gives the stable id on both insert and update; the id is never regenerated.
  const upsertAccountStmt = db.prepare(`
    INSERT INTO accounts (id, item_id, provider, provider_account_id, name, official_name, mask,
                          type, subtype, iso_currency_code, created_at, updated_at)
    VALUES (@id, @item_id, @provider, @provider_account_id, @name, @official_name, @mask,
            @type, @subtype, @iso_currency_code, @now, @now)
    ON CONFLICT(provider, provider_account_id) DO UPDATE SET
      item_id = excluded.item_id,
      name = excluded.name,
      official_name = excluded.official_name,
      mask = excluded.mask,
      type = excluded.type,
      subtype = excluded.subtype,
      iso_currency_code = excluded.iso_currency_code,
      updated_at = excluded.updated_at
    RETURNING id
  `);
  const deleteFieldsStmt = db.prepare(
    `DELETE FROM account_fields WHERE account_id = ? AND provider = ?`
  );
  const insertFieldStmt = db.prepare(`
    INSERT INTO account_fields (account_id, field, provider, status, value_json, observed_at, error_code)
    VALUES (@account_id, @field, @provider, @status, @value_json, @observed_at, @error_code)
  `);
  const listAccountsStmt = db.prepare(`
    SELECT a.id, a.item_id, a.provider, a.provider_account_id, a.name, a.official_name, a.mask,
           a.type, a.subtype, a.iso_currency_code, a.created_at, a.updated_at,
           i.institution_name, i.status AS item_status, i.last_synced_at,
           i.liabilities_status, i.balance_source, i.last_refreshed_at
    FROM accounts a
    JOIN plaid_items i ON i.item_id = a.item_id
    ORDER BY a.created_at, a.id
  `);
  const listFieldsStmt = db.prepare(
    `SELECT account_id, field, provider, status, value_json, observed_at, error_code FROM account_fields`
  );
  const setMetaStmt = db.prepare(`
    UPDATE plaid_items SET liabilities_status = ?, balance_source = ?, last_refreshed_at = ?
    WHERE item_id = ?
  `);
  const getAccountStmt = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`);

  const upsertAll = db.transaction(
    (
      item_id: string,
      provider: string,
      cards: Parameters<CardsRepo["upsertAccounts"]>[2]
    ): Record<string, string> => {
      const now = new Date().toISOString();
      const ids: Record<string, string> = {};
      for (const c of cards) {
        const row = upsertAccountStmt.get({
          id: randomUUID(),
          item_id,
          provider,
          provider_account_id: c.provider_account_id,
          name: c.name,
          official_name: c.official_name,
          mask: c.mask,
          type: c.type,
          subtype: c.subtype,
          iso_currency_code: c.iso_currency_code,
          now,
        }) as { id: string };
        ids[c.provider_account_id] = row.id;
      }
      return ids;
    }
  );

  const replaceFields = db.transaction(
    (
      account_id: string,
      provider: string,
      obs: Partial<Record<FieldKey, FieldObservation>>
    ) => {
      deleteFieldsStmt.run(account_id, provider);
      for (const field of FIELD_KEYS) {
        const o = obs[field];
        if (!o) continue;
        insertFieldStmt.run({
          account_id,
          field,
          provider,
          status: o.status,
          value_json: o.value === null || o.value === undefined ? null : JSON.stringify(o.value),
          observed_at: o.observed_at,
          error_code: o.error_code,
        });
      }
    }
  );

  return {
    async upsertAccounts(item_id, provider, cards) {
      return upsertAll(item_id, provider, cards);
    },
    async replaceAccountFields(account_id, provider, obs) {
      replaceFields(account_id, provider, obs);
    },
    async listCardRows() {
      const accounts = listAccountsStmt.all() as JoinedAccountRow[];
      const byAccount = new Map<string, Partial<Record<FieldKey, FieldObservation>>>();
      for (const f of listFieldsStmt.all() as Array<FieldDbRow & { provider: string }>) {
        if (!FIELD_SET.has(f.field)) continue;
        const bucket = byAccount.get(f.account_id) ?? {};
        bucket[f.field as FieldKey] = {
          status: f.status as FieldStatus,
          value: parseValue(f.value_json),
          observed_at: f.observed_at,
          error_code: f.error_code,
        };
        byAccount.set(f.account_id, bucket);
      }
      return accounts.map(
        (a): CardRow => ({
          id: a.id,
          item_id: a.item_id,
          provider: a.provider,
          provider_account_id: a.provider_account_id,
          name: a.name,
          official_name: a.official_name,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          iso_currency_code: a.iso_currency_code,
          created_at: a.created_at,
          institution_name: a.institution_name,
          item_status: a.item_status ?? "active",
          last_synced_at: a.last_synced_at,
          liabilities_status: a.liabilities_status,
          balance_source: a.balance_source,
          last_refreshed_at: a.last_refreshed_at,
          fields: byAccount.get(a.id) ?? {},
        })
      );
    },
    async setItemRefreshMeta(item_id, meta: ItemRefreshMeta) {
      setMetaStmt.run(meta.liabilities_status, meta.balance_source, meta.last_refreshed_at, item_id);
    },
    async getAccountById(id) {
      const r = getAccountStmt.get(id) as AccountRow | undefined;
      return r ?? null;
    },
  };
}
