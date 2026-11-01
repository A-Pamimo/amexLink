import type { DB } from "@/lib/db";

export const SEED_TOKEN = "access-sandbox-secret-123";

/** Insert a plaid item (and optionally one transaction) for route-level tests. */
export async function seedItem(
  db: DB,
  over: Partial<{ id: string; item_id: string; access_token: string; withTx: boolean }> = {}
) {
  const item_id = over.item_id ?? "plaid-item-1";
  const item = await db.insertItem({
    id: over.id ?? "row-1",
    access_token: over.access_token ?? SEED_TOKEN,
    item_id,
    institution_name: "Amex Canada",
    institution_id: "ins_100533",
  });
  if (over.withTx) {
    await db.upsertAddedTransactions([
      {
        id: `tx-${item_id}`,
        account_id: "acc-1",
        item_id,
        name: "STARBUCKS",
        amount: 5,
        iso_currency_code: "CAD",
        date: "2026-10-01",
        plaid_category: null,
        plaid_category_detailed: null,
        merchant_name: "Starbucks",
        logo_url: null,
        bucket: "food",
        pending: false,
      },
    ]);
  }
  return item;
}

export function req(url: string, init?: RequestInit) {
  return new Request(`http://localhost${url}`, init);
}
