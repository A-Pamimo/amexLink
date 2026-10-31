/**
 * Provider-neutral card data model (docs/ARCHITECTURE.md sections 2-3).
 *
 * Every card field is its own observation with provenance (which provider, when, and why it
 * is missing). There is no manual-entry path: values only ever come from an aggregation API.
 */

export const FIELD_KEYS = [
  "current_balance",
  "available_credit",
  "credit_limit",
  "statement_balance",
  "minimum_payment",
  "next_payment_due_date",
  "last_payment_amount",
  "last_payment_date",
  "last_statement_issue_date",
  "is_overdue",
  "apr",
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

/**
 * - present: value is from the provider
 * - not_supplied: the call succeeded and this field was null / empty
 * - not_supported: the institution or product does not offer it
 * - consent_required: Plaid needs an update-mode Link session (additional consent)
 * - error: the call failed; `error_code` is a provider code enum, never a message body
 */
export type FieldStatus =
  | "present"
  | "not_supplied"
  | "not_supported"
  | "consent_required"
  | "error";

export interface FieldObservation {
  status: FieldStatus;
  value: unknown | null;
  /** ISO timestamp of the provider call that produced this observation. */
  observed_at: string;
  error_code: string | null;
}

export type ProviderId = "plaid" | "yodlee" | "mx" | "flinks";

/** Highest priority first. A `present` observation always beats a non-present one. */
export const PROVIDER_PRIORITY: ProviderId[] = ["plaid", "yodlee", "mx", "flinks"];

export interface ProviderCard {
  provider_account_id: string;
  name: string | null;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  iso_currency_code: string | null;
  fields: Partial<Record<FieldKey, FieldObservation>>;
}

export type LiabilitiesStatus = "ok" | "not_supported" | "consent_required" | "pending" | "error";
export type BalanceSource = "realtime" | "cached" | "error";

export interface ProviderRefresh {
  /** False means the account list could not be fetched: callers must not touch stored cards. */
  accounts_fetched: boolean;
  balance_source: BalanceSource;
  liabilities_status: LiabilitiesStatus;
  error_code: string | null;
  cards: ProviderCard[];
}

export interface CardProvider {
  id: ProviderId;
  /** Never throws on provider failures; they are reported in the returned status fields. */
  refresh(
    secret: { access_token: string },
    opts: { realtimeBalance: boolean }
  ): Promise<ProviderRefresh>;
}

/** An `accounts` row without observations. */
export interface AccountRow {
  id: string;
  item_id: string;
  provider: string;
  provider_account_id: string;
  name: string | null;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  iso_currency_code: string | null;
  created_at: string;
  updated_at: string;
}

/** One stored provider account with its observations, joined with its item (see CardsRepo). */
export interface CardRow extends Omit<AccountRow, "updated_at"> {
  institution_name: string | null;
  item_status: string;
  last_synced_at: string | null;
  liabilities_status: string | null;
  balance_source: string | null;
  last_refreshed_at: string | null;
  fields: Partial<Record<FieldKey, FieldObservation>>;
}
