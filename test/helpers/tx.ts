import type { TransactionInsert } from "@/lib/db";

let n = 0;

/** A spending transaction row for stats tests; override any field. */
export function tx(over: Partial<TransactionInsert> = {}): TransactionInsert {
  n += 1;
  return {
    id: `tx-${n}`,
    account_id: "acc-1",
    item_id: "plaid-item-1",
    name: "STARBUCKS",
    amount: 10,
    iso_currency_code: "CAD",
    date: "2026-10-05",
    plaid_category: null,
    plaid_category_detailed: null,
    merchant_name: null,
    logo_url: null,
    bucket: "food",
    pending: false,
    ...over,
  };
}
