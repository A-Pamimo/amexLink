import "server-only";
import type { Transaction as PlaidTx } from "plaid";
import { categorizeTx } from "./categorize";
import { getDB, type TransactionInsert } from "./db";
import { getPlaid } from "./plaid";
import type { PlaidItem, SyncResult } from "./types";

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

export async function syncItem(item: PlaidItem): Promise<SyncResult> {
  const db = await getDB();
  const plaid = getPlaid();

  const secret = await db.getItemSecret(item.item_id);
  if (!secret) throw new Error(`No access token stored for item ${item.item_id}`);

  let cursor: string | undefined = item.cursor ?? undefined;
  const added: PlaidTx[] = [];
  const modified: PlaidTx[] = [];
  const removedIds: string[] = [];

  while (true) {
    const res = await plaid.transactionsSync({
      access_token: secret.access_token,
      cursor,
      options: { include_personal_finance_category: true },
    });
    added.push(...(res.data.added as PlaidTx[]));
    modified.push(...(res.data.modified as PlaidTx[]));
    removedIds.push(...res.data.removed.map((r) => r.transaction_id!).filter(Boolean));
    cursor = res.data.next_cursor;
    if (!res.data.has_more) break;
  }

  const addedRows = added.map((t) => toInsert(t, item.item_id));
  const modifiedRows = modified.map((t) => toInsert(t, item.item_id));

  const a = await db.upsertAddedTransactions(addedRows);
  const m = await db.upsertModifiedTransactions(modifiedRows);
  const r = await db.removeTransactions(removedIds);

  await db.updateItemSync(item.item_id, cursor ?? "", new Date().toISOString());

  return { added: a, modified: m, removed: r };
}

export async function syncAllItems(): Promise<SyncResult> {
  const db = await getDB();
  const items = await db.listItems();
  const total: SyncResult = { added: 0, modified: 0, removed: 0 };
  for (const item of items) {
    const r = await syncItem(item);
    total.added += r.added;
    total.modified += r.modified;
    total.removed += r.removed;
  }
  return total;
}
