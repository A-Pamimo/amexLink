import "server-only";
import type { Transaction as PlaidTx } from "plaid";
import { refreshItemCards } from "./cards/refresh";
import { categorizeTx } from "./categorize";
import { getDB, type TransactionInsert } from "./db";
import { extractProviderError, mapProviderCode } from "./http/errors";
import { logEvent } from "./http/log-shim";
import { getPlaid } from "./plaid";
import { withItemLock } from "./sync/lock";
import type { ItemSyncSummary, PlaidItem, SyncAllResult, SyncResult } from "./types";

function toInsert(tx: PlaidTx, item_id: string): TransactionInsert {
  const detailed = tx.personal_finance_category?.detailed ?? null;
  const primary = tx.personal_finance_category?.primary ?? null;
  const merchant = tx.merchant_name ?? tx.name ?? null;
  return {
    id: tx.transaction_id,
    account_id: tx.account_id,
    item_id,
    name: tx.name,
    // Plaid sign convention: positive = outflow (money leaving the account).
    amount: tx.amount,
    iso_currency_code: tx.iso_currency_code ?? tx.unofficial_currency_code ?? null,
    date: tx.date,
    plaid_category: primary,
    plaid_category_detailed: detailed,
    merchant_name: merchant,
    logo_url: tx.logo_url ?? tx.personal_finance_category_icon_url ?? null,
    bucket: categorizeTx(detailed, merchant),
    pending: tx.pending === true,
  };
}

/** Typed sync failure. `code` is a stable client code; never contains provider text. */
export class SyncError extends Error {
  readonly code: string;
  readonly provider_code?: string;

  constructor(code: string, provider_code?: string) {
    super(`Sync failed (${code})`);
    this.name = "SyncError";
    this.code = code;
    this.provider_code = provider_code;
  }
}

const MAX_ATTEMPTS = 3;
const MUTATION_CODE = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
const RELINK_CODES = new Set(["ITEM_LOGIN_REQUIRED", "INVALID_ACCESS_TOKEN"]);

function isCredentialError(err: unknown): boolean {
  // Detect by name so this file does not depend on WP3's error class.
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === "string" && /Decrypt|TokenUnreadable/i.test(name);
}

/** Runs the paged /transactions/sync loop once; each page is applied in one DB transaction. */
async function runPages(
  access_token: string,
  item_id: string,
  startCursor: string | null,
  totals: SyncResult
): Promise<string | null> {
  const db = await getDB();
  const plaid = getPlaid();
  let cursor: string | undefined = startCursor ?? undefined;
  while (true) {
    // Provider HTTP call: never inside a DB transaction.
    const res = await plaid.transactionsSync({
      access_token,
      cursor,
      options: { include_personal_finance_category: true },
    });
    const page = await db.applyTransactionPage({
      added: (res.data.added as PlaidTx[]).map((t) => toInsert(t, item_id)),
      modified: (res.data.modified as PlaidTx[]).map((t) => toInsert(t, item_id)),
      removedIds: res.data.removed.map((r) => r.transaction_id!).filter(Boolean),
    });
    totals.added += page.added;
    totals.modified += page.modified;
    totals.removed += page.removed;
    cursor = res.data.next_cursor || undefined; // never carry "" forward
    if (!res.data.has_more) break;
  }
  return cursor ?? null;
}

async function syncLocked(item_id: string): Promise<SyncResult> {
  const db = await getDB();
  // Re-read inside the lock: a queued call must start from the cursor the previous call saved.
  const item = await db.getItemByItemId(item_id);
  if (!item) throw new SyncError("item_not_found");

  let access_token: string;
  try {
    const secret = await db.getItemSecret(item_id);
    if (!secret) throw new SyncError("credential_unavailable");
    access_token = secret.access_token;
  } catch (err) {
    if (err instanceof SyncError) throw err;
    if (isCredentialError(err)) {
      await db.setItemStatus(item_id, "needs_relink", "credential_unreadable");
      logEvent("sync_credential_unreadable", { item_id });
      throw new SyncError("credential_unavailable");
    }
    throw new SyncError("sync_failed");
  }

  const startCursor = item.cursor ? item.cursor : null;
  const totals: SyncResult = { added: 0, modified: 0, removed: 0 };
  let nextCursor: string | null = null;

  for (let attempt = 1; ; attempt++) {
    try {
      nextCursor = await runPages(access_token, item_id, startCursor, totals);
      break;
    } catch (err) {
      const info = extractProviderError(err);
      if (info.error_code === MUTATION_CODE && attempt < MAX_ATTEMPTS) {
        // Plaid asks for a restart from the cursor the loop began with.
        logEvent("sync_pagination_restart", { item_id, attempt });
        continue;
      }
      if (info.error_code && RELINK_CODES.has(info.error_code)) {
        await db.setItemStatus(item_id, "needs_relink", info.error_code);
      } else if (info.error_code === "ADDITIONAL_CONSENT_REQUIRED") {
        await db.setItemStatus(item_id, "consent_required", info.error_code);
      }
      logEvent("sync_failed", {
        item_id,
        error_code: info.error_code,
        error_type: info.error_type,
        request_id: info.request_id,
        status: info.status,
      });
      if (info.error_code) {
        throw new SyncError(mapProviderCode(info.error_code).code, info.error_code);
      }
      throw new SyncError("sync_failed");
    }
  }

  if (nextCursor) {
    const stored = await db.casUpdateCursor(
      item_id,
      startCursor,
      nextCursor,
      new Date().toISOString()
    );
    if (!stored) {
      // Someone else moved the cursor while we were paging. Pages were applied idempotently;
      // keep their cursor and let the next sync catch up.
      logEvent("sync_cursor_conflict", { item_id });
    }
  }

  if (item.status === "needs_relink" || item.status === "consent_required") {
    await db.setItemStatus(item_id, "active", null);
  }
  // WP6a: card balances and liabilities. Transactions are already committed and the cursor has
  // advanced, so nothing here may fail the sync. Cached balances only (`/accounts/get`); the
  // billed live call is reserved for the explicit per-card refresh route.
  try {
    await refreshItemCards(item_id, { realtimeBalance: false });
  } catch (err) {
    logEvent("cards_refresh_failed", {
      item_id,
      error_code: extractProviderError(err).error_code,
    });
  }

  logEvent("sync_finished", { item_id, ...totals });
  return totals;
}

/** One sync per item at a time (in-process lock); cursor advances only via compare-and-set. */
export async function syncItem(item: PlaidItem): Promise<SyncResult> {
  return withItemLock(item.item_id, () => syncLocked(item.item_id));
}

/** Syncs every item, continuing past per-item failures. */
export async function syncAllItems(): Promise<SyncAllResult> {
  const db = await getDB();
  const items = await db.listItems();
  const out: ItemSyncSummary[] = [];
  const totals: SyncResult = { added: 0, modified: 0, removed: 0 };
  for (const item of items) {
    try {
      const r = await syncItem(item);
      out.push({ item_id: item.item_id, ok: true, ...r });
      totals.added += r.added;
      totals.modified += r.modified;
      totals.removed += r.removed;
    } catch (err) {
      out.push({
        item_id: item.item_id,
        ok: false,
        added: 0,
        modified: 0,
        removed: 0,
        error_code: err instanceof SyncError ? err.code : "sync_failed",
      });
    }
  }
  return { items: out, totals };
}
