import type { ReactNode } from "react";
import { formatCurrency, formatDateRelative } from "@/lib/format";
import type { FieldObservation, FieldStatus } from "@/lib/providers/types";

/** A merged observation plus the provider that supplied it (what GET /api/cards returns). */
export type FieldObs = FieldObservation & { provider: string };

export type FieldKind = "money" | "date" | "boolean" | "apr";

const PROVIDER_LABEL: Record<string, string> = {
  plaid: "Plaid",
  yodlee: "Yodlee",
  mx: "MX",
  flinks: "Flinks",
};

const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? p;

const APR_LABEL: Record<string, string> = {
  purchase_apr: "Purchase",
  cash_apr: "Cash",
  balance_transfer_apr: "Balance transfer",
  penalty_apr: "Penalty",
  special: "Special",
};

/**
 * The words shown for a field that has no value, with the reason. Pure and exported so tests
 * (and the card footer) can use the exact same strings.
 */
export function gapText(status: Exclude<FieldStatus, "present">, provider: string, errorCode: string | null): string {
  const who = providerLabel(provider);
  switch (status) {
    case "not_supplied":
      return `Not supplied by ${who}`;
    case "not_supported":
      return `${who} does not support this field at this institution`;
    case "consent_required":
      return `Reconnect ${who} to grant liabilities access`;
    case "error":
      return `Unavailable (${who} error ${errorCode ?? "unknown"})`;
  }
}

/** Muted gap text with an explanatory tooltip. Display only. */
export function Gap({ text, title, status }: { text: string; title?: string; status?: string }) {
  return (
    <span className="text-xs italic text-slate-500" title={title} data-gap={status ?? "gap"}>
      {text}
    </span>
  );
}

const aprNumber = (n: number) => `${Number(n.toFixed(2))}%`;

function renderPresent(
  value: unknown,
  kind: FieldKind,
  currency: string | null,
  today: string | undefined
): ReactNode | null {
  switch (kind) {
    case "money":
      return typeof value === "number" && Number.isFinite(value) ? formatCurrency(value, currency) : null;
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const rel = today ? formatDateRelative(value, today) : "";
      return rel ? (
        <>
          {value} <span className="text-slate-400">({rel})</span>
        </>
      ) : (
        value
      );
    }
    case "boolean":
      return typeof value === "boolean" ? (value ? "Yes" : "No") : null;
    case "apr": {
      if (!Array.isArray(value) || value.length === 0) return null;
      const rows = value.filter(
        (a): a is { apr_type: string; apr_percentage: number } =>
          !!a &&
          typeof a === "object" &&
          typeof (a as { apr_type?: unknown }).apr_type === "string" &&
          typeof (a as { apr_percentage?: unknown }).apr_percentage === "number"
      );
      if (rows.length === 0) return null;
      return (
        <ul className="space-y-0.5">
          {rows.map((a, i) => (
            <li key={`${a.apr_type}-${i}`}>
              <span className="text-slate-400">{APR_LABEL[a.apr_type] ?? a.apr_type}</span>{" "}
              {aprNumber(a.apr_percentage)}
            </li>
          ))}
        </ul>
      );
    }
  }
}

/**
 * Renders one field observation. `present` shows the formatted value; every other status shows
 * why the value is missing (muted) with a tooltip carrying the provider and `observed_at`.
 * There is deliberately no input, button or edit affordance: card data comes from the
 * aggregation API only (CLAUDE.md, SECURITY.md P-T1).
 */
export function FieldValue({
  obs,
  kind,
  currency = null,
  today,
}: {
  obs: FieldObs;
  kind: FieldKind;
  /** ISO currency of the card; money is formatted in it, never in a default. */
  currency?: string | null;
  /** America/Toronto civil date, for relative wording of dates. */
  today?: string;
}) {
  const observed = obs.observed_at ? `observed ${obs.observed_at}` : "not observed";
  const title = `${providerLabel(obs.provider)}: ${obs.status}, ${observed}`;

  if (obs.status === "present") {
    const shown = renderPresent(obs.value, kind, currency, today);
    if (shown !== null) {
      return (
        <span className="text-sm text-slate-100" title={title}>
          {shown}
        </span>
      );
    }
    return (
      <Gap
        status="unexpected_value"
        text={`Unexpected value from ${providerLabel(obs.provider)}`}
        title={title}
      />
    );
  }
  const code = obs.status === "error" ? obs.error_code : null;
  return <Gap status={obs.status} text={gapText(obs.status, obs.provider, code)} title={title} />;
}
