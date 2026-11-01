import {
  FIELD_KEYS,
  PROVIDER_PRIORITY,
  type CardRow,
  type FieldKey,
  type FieldObservation,
} from "../providers/types";

/** An observation plus the provider that supplied it (provenance for the UI gap text). */
export type MergedObservation = FieldObservation & { provider: string };

export interface Utilization {
  /** current_balance / credit_limit, only when both are present and the limit is > 0. */
  ratio: number | null;
  /** Always true: utilization is derived here, never supplied by an issuer. */
  computed: true;
  /** Why `ratio` is null (a stable code, not prose). */
  reason?: "missing_current_balance" | "missing_credit_limit" | "credit_limit_not_positive";
}

export interface MergedCard {
  /** Account id of the highest-priority provider row; accepted by /api/cards/[id]/refresh. */
  id: string;
  /** Every stored account id merged into this card. */
  account_ids: string[];
  providers: string[];
  institution_name: string | null;
  name: string | null;
  mask: string | null;
  iso_currency_code: string | null;
  item_id: string;
  item_status: string;
  last_synced_at: string | null;
  liabilities_status: string | null;
  balance_source: string | null;
  last_refreshed_at: string | null;
  fields: Record<FieldKey, MergedObservation>;
  utilization: Utilization;
}

function priorityIndex(provider: string): number {
  const i = (PROVIDER_PRIORITY as string[]).indexOf(provider);
  return i === -1 ? PROVIDER_PRIORITY.length : i;
}

/** Lowercase, strip diacritics and everything that is not a letter or digit. */
export function normalizeInstitution(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function last4(mask: string | null | undefined): string {
  return (mask ?? "").trim().slice(-4);
}

/**
 * Reconciliation key: normalize(institution) + ":" + last4(mask) + ":" + currency.
 * When BOTH institution and mask are missing the provider account id is used instead, so
 * unrelated cards are never glued together.
 */
export function reconciliationKey(row: CardRow): string {
  const inst = normalizeInstitution(row.institution_name);
  const l4 = last4(row.mask);
  if (!inst && !l4) return `${row.provider}:${row.provider_account_id}`;
  return `${inst}:${l4}:${row.iso_currency_code ?? ""}`;
}

/** Negative when `a` should win over `b` for one field. */
function compareObservations(
  a: { o: FieldObservation; provider: string },
  b: { o: FieldObservation; provider: string }
): number {
  const ap = a.o.status === "present" ? 0 : 1;
  const bp = b.o.status === "present" ? 0 : 1;
  if (ap !== bp) return ap - bp; // a present value always wins
  const byProvider = priorityIndex(a.provider) - priorityIndex(b.provider);
  if (byProvider !== 0) return byProvider;
  // Same provider twice (a card linked through two Items): the newer observation wins.
  return a.o.observed_at < b.o.observed_at ? 1 : a.o.observed_at > b.o.observed_at ? -1 : 0;
}

function pickField(rows: CardRow[], key: FieldKey): MergedObservation {
  let best: { o: FieldObservation; provider: string } | null = null;
  for (const row of rows) {
    const o = row.fields[key];
    if (!o) continue;
    const cand = { o, provider: row.provider };
    if (!best || compareObservations(cand, best) < 0) best = cand;
  }
  if (!best) {
    // No provider reported this field at all: say so rather than inventing a status.
    return {
      status: "not_supplied",
      value: null,
      observed_at: rows[0]?.last_refreshed_at ?? "",
      error_code: "NO_OBSERVATION",
      provider: rows[0]?.provider ?? "unknown",
    };
  }
  return { ...best.o, provider: best.provider };
}

function computeUtilization(fields: Record<FieldKey, MergedObservation>): Utilization {
  const bal = fields.current_balance;
  const lim = fields.credit_limit;
  if (bal.status !== "present" || typeof bal.value !== "number") {
    return { ratio: null, computed: true, reason: "missing_current_balance" };
  }
  if (lim.status !== "present" || typeof lim.value !== "number") {
    return { ratio: null, computed: true, reason: "missing_credit_limit" };
  }
  if (!(lim.value > 0)) {
    return { ratio: null, computed: true, reason: "credit_limit_not_positive" };
  }
  return { ratio: bal.value / lim.value, computed: true };
}

/**
 * Merge runs on read. Stored rows stay per provider account (docs/ARCHITECTURE.md section 3).
 *  - a `present` observation wins over any non-present one;
 *  - among present ones, PROVIDER_PRIORITY order decides;
 *  - if nobody has a present value, the highest-priority observation is kept so the UI can
 *    show why (a lower provider's `not_supported` never hides Plaid's `not_supplied`).
 */
export function mergeCards(rows: CardRow[]): MergedCard[] {
  const groups = new Map<string, CardRow[]>();
  for (const row of rows) {
    const key = reconciliationKey(row);
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }

  const out: MergedCard[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => priorityIndex(a.provider) - priorityIndex(b.provider));
    const primary = sorted[0];
    const fields = {} as Record<FieldKey, MergedObservation>;
    for (const k of FIELD_KEYS) fields[k] = pickField(sorted, k);

    out.push({
      id: primary.id,
      account_ids: sorted.map((r) => r.id),
      providers: [...new Set(sorted.map((r) => r.provider))],
      institution_name: primary.institution_name,
      name: primary.name ?? primary.official_name,
      mask: primary.mask,
      iso_currency_code: primary.iso_currency_code,
      item_id: primary.item_id,
      item_status: primary.item_status,
      last_synced_at: primary.last_synced_at,
      liabilities_status: primary.liabilities_status,
      balance_source: primary.balance_source,
      last_refreshed_at: primary.last_refreshed_at,
      fields,
      utilization: computeUtilization(fields),
    });
  }
  return out;
}
