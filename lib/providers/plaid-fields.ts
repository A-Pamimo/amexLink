import type { FieldKey, FieldObservation, FieldStatus, LiabilitiesStatus, ProviderCard } from "./types";

/**
 * Explicit pickers from Plaid response objects (SECURITY.md 3.5, P-T2, P-I2).
 *
 * Rules, enforced by construction:
 *  - every output property is read by name; a Plaid object is NEVER spread or iterated;
 *  - anything not listed here (`numbers`, `owners`, `account_number`, `verification_status`,
 *    `persistent_account_id`, `cash_advance_limit`, ...) is dropped and never logged;
 *  - values are type-checked, so an unexpected shape becomes `not_supplied`, not a stored blob.
 */

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** YYYY-MM-DD only; a Plaid date is never a timestamp. */
const dateStr = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

export interface PickedAccount {
  provider_account_id: string;
  name: string | null;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  iso_currency_code: string | null;
  current: number | null;
  available: number | null;
  limit: number | null;
}

/** Account metadata and the three balances. Everything else on the account object is ignored. */
export function pickAccount(raw: unknown): PickedAccount | null {
  if (!isObj(raw)) return null;
  const provider_account_id = str(raw.account_id);
  if (!provider_account_id) return null;
  const balances = isObj(raw.balances) ? raw.balances : {};
  return {
    provider_account_id,
    name: str(raw.name),
    official_name: str(raw.official_name),
    mask: str(raw.mask),
    type: str(raw.type),
    subtype: str(raw.subtype),
    iso_currency_code: str(balances.iso_currency_code),
    current: num(balances.current),
    available: num(balances.available),
    limit: num(balances.limit),
  };
}

export interface PickedApr {
  apr_percentage: number;
  /** balance_transfer_apr | cash_apr | penalty_apr | purchase_apr | special (verified 2026-10-30). */
  apr_type: string;
  balance_subject_to_apr: number | null;
  interest_charge_amount: number | null;
}

export function pickAprs(raw: unknown): PickedApr[] {
  if (!Array.isArray(raw)) return [];
  const out: PickedApr[] = [];
  for (const a of raw) {
    if (!isObj(a)) continue;
    const apr_percentage = num(a.apr_percentage);
    const apr_type = str(a.apr_type);
    if (apr_percentage === null || apr_type === null) continue;
    out.push({
      apr_percentage,
      apr_type,
      balance_subject_to_apr: num(a.balance_subject_to_apr),
      interest_charge_amount: num(a.interest_charge_amount),
    });
  }
  return out;
}

export interface PickedLiability {
  account_id: string;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  last_statement_balance: number | null;
  last_statement_issue_date: string | null;
  is_overdue: boolean | null;
  aprs: PickedApr[];
}

export function pickLiability(raw: unknown): PickedLiability | null {
  if (!isObj(raw)) return null;
  const account_id = str(raw.account_id);
  if (!account_id) return null;
  return {
    account_id,
    minimum_payment_amount: num(raw.minimum_payment_amount),
    next_payment_due_date: dateStr(raw.next_payment_due_date),
    last_payment_amount: num(raw.last_payment_amount),
    last_payment_date: dateStr(raw.last_payment_date),
    last_statement_balance: num(raw.last_statement_balance),
    last_statement_issue_date: dateStr(raw.last_statement_issue_date),
    is_overdue: bool(raw.is_overdue),
    aprs: pickAprs(raw.aprs),
  };
}

// --- liabilities error mapping ------------------------------------------------------------

export interface LiabilitiesFailure {
  status: Exclude<LiabilitiesStatus, "ok">;
  error_code: string | null;
}

const NOT_SUPPORTED = new Set(["PRODUCTS_NOT_SUPPORTED", "NO_LIABILITY_ACCOUNTS", "PRODUCT_NOT_SUPPORTED"]);

/** Maps a Plaid `error_code` enum string (or undefined) to a liabilities status. */
export function mapLiabilitiesError(error_code: string | undefined): LiabilitiesFailure {
  if (error_code === "ADDITIONAL_CONSENT_REQUIRED") return { status: "consent_required", error_code };
  if (error_code && NOT_SUPPORTED.has(error_code)) return { status: "not_supported", error_code };
  if (error_code === "PRODUCT_NOT_READY") return { status: "pending", error_code };
  return { status: "error", error_code: error_code ?? "UNKNOWN" };
}

// --- observation builders -----------------------------------------------------------------

function obs(
  status: FieldStatus,
  value: unknown,
  observed_at: string,
  error_code: string | null = null
): FieldObservation {
  return { status, value: value ?? null, observed_at, error_code };
}

const present = (value: unknown, at: string) => obs("present", value, at);
const notSupplied = (at: string) => obs("not_supplied", null, at);
const orMissing = (value: unknown, at: string) => (value === null ? notSupplied(at) : present(value, at));

export const LIABILITY_FIELDS = [
  "statement_balance",
  "minimum_payment",
  "next_payment_due_date",
  "last_payment_amount",
  "last_payment_date",
  "last_statement_issue_date",
  "is_overdue",
  "apr",
] as const satisfies readonly FieldKey[];

/** Failure status for a liability field when `/liabilities/get` did not succeed. */
function failureObservation(f: LiabilitiesFailure, at: string): FieldObservation {
  switch (f.status) {
    case "consent_required":
      return obs("consent_required", null, at, f.error_code);
    case "not_supported":
      return obs("not_supported", null, at, f.error_code);
    case "pending":
      // FieldStatus has no "pending": the data is absent because the call did not succeed yet.
      return obs("error", null, at, f.error_code ?? "PRODUCT_NOT_READY");
    default:
      return obs("error", null, at, f.error_code ?? "UNKNOWN");
  }
}

/**
 * Builds the card for one credit account.
 * `liability` is the matching `credit[]` entry when the call succeeded (null = no entry);
 * `failure` is set instead when the call failed.
 */
export function buildCard(
  account: PickedAccount,
  liability: PickedLiability | null,
  failure: LiabilitiesFailure | null,
  observed_at: string
): ProviderCard {
  const fields: Partial<Record<FieldKey, FieldObservation>> = {
    current_balance: orMissing(account.current, observed_at),
    available_credit: orMissing(account.available, observed_at),
    credit_limit: orMissing(account.limit, observed_at),
  };

  if (failure) {
    for (const k of LIABILITY_FIELDS) fields[k] = failureObservation(failure, observed_at);
  } else {
    const l = liability;
    fields.statement_balance = orMissing(l?.last_statement_balance ?? null, observed_at);
    fields.minimum_payment = orMissing(l?.minimum_payment_amount ?? null, observed_at);
    fields.next_payment_due_date = orMissing(l?.next_payment_due_date ?? null, observed_at);
    fields.last_payment_amount = orMissing(l?.last_payment_amount ?? null, observed_at);
    fields.last_payment_date = orMissing(l?.last_payment_date ?? null, observed_at);
    fields.last_statement_issue_date = orMissing(l?.last_statement_issue_date ?? null, observed_at);
    // `false` is a real answer ("not overdue"), not a gap.
    fields.is_overdue = orMissing(l?.is_overdue ?? null, observed_at);
    // An empty APR array means the issuer did not supply any APR.
    fields.apr = l && l.aprs.length > 0 ? present(l.aprs, observed_at) : notSupplied(observed_at);
  }

  return {
    provider_account_id: account.provider_account_id,
    name: account.name,
    official_name: account.official_name,
    mask: account.mask,
    type: account.type,
    subtype: account.subtype,
    iso_currency_code: account.iso_currency_code,
    fields,
  };
}
