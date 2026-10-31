import type {
  CardRow,
  FieldKey,
  FieldObservation,
  FieldStatus,
  ProviderCard,
} from "@/lib/providers/types";

export const AT = "2026-10-31T12:00:00.000Z";

/** Observation factory. */
export function ob(
  status: FieldStatus,
  value: unknown = null,
  over: Partial<FieldObservation> = {}
): FieldObservation {
  return { status, value: status === "present" ? value : null, observed_at: AT, error_code: null, ...over };
}

export const present = (value: unknown) => ob("present", value);

/** A stored card row (what CardsRepo.listCardRows returns). */
export function makeRow(over: Partial<CardRow> & { fields?: Partial<Record<FieldKey, FieldObservation>> } = {}): CardRow {
  return {
    id: "acc-1",
    item_id: "item-1",
    provider: "plaid",
    provider_account_id: "pa-1",
    name: "Cobalt",
    official_name: null,
    mask: "1005",
    type: "credit",
    subtype: "credit card",
    iso_currency_code: "CAD",
    created_at: AT,
    institution_name: "American Express Canada",
    item_status: "active",
    last_synced_at: AT,
    liabilities_status: "ok",
    balance_source: "cached",
    last_refreshed_at: AT,
    fields: {},
    ...over,
  };
}

/** A provider card with every field "present" unless overridden. */
export function makeCard(
  provider_account_id: string,
  over: Partial<ProviderCard> = {},
  fields: Partial<Record<FieldKey, FieldObservation>> = {}
): ProviderCard {
  return {
    provider_account_id,
    name: "Cobalt",
    official_name: null,
    mask: "1005",
    type: "credit",
    subtype: "credit card",
    iso_currency_code: "CAD",
    fields: {
      current_balance: present(100),
      available_credit: present(900),
      credit_limit: present(1000),
      statement_balance: present(80),
      minimum_payment: present(10),
      next_payment_due_date: present("2099-01-15"),
      last_payment_amount: present(50),
      last_payment_date: present("2026-10-01"),
      last_statement_issue_date: present("2026-10-20"),
      is_overdue: present(false),
      apr: present([{ apr_percentage: 20, apr_type: "purchase_apr", balance_subject_to_apr: null, interest_charge_amount: null }]),
      ...fields,
    },
    ...over,
  };
}
