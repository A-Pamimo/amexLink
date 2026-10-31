import { isUnknownCurrency } from "./currency";

/**
 * Format `amount` in `currency` (ISO 4217). The currency is required: there is no default, so a
 * CAD amount can never be shown as USD by accident. `null` / `"UNKNOWN"` (no code from the
 * provider) renders as a plain number; callers show a "currency unknown" caption beside it.
 */
export function formatCurrency(amount: number, currency: string | null): string {
  if (isUnknownCurrency(currency)) {
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency as string,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** Caption for amounts that have no currency code; undefined when the currency is known. */
export function currencyCaption(currency: string | null | undefined): string | undefined {
  return isUnknownCurrency(currency) ? "currency unknown" : undefined;
}

// Plaid sign convention: positive = outflow. For UI we want to show
// outflows as positive and inflows as negative red numbers.
export function displayAmount(amount: number, currency: string | null): string {
  return formatCurrency(amount, currency);
}

export function formatDate(d: string): string {
  // YYYY-MM-DD -> short locale-independent rendering
  const [y, m, day] = d.split("-");
  if (!y || !m || !day) return d;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1] ?? m} ${parseInt(day, 10)}, ${y}`;
}

/** ISO timestamp -> "2026-10-31 08:00" in America/Toronto. Returns "" for an invalid timestamp. */
export function formatTimestampToronto(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(t);
  const g = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

/** 0.2345 -> "23.5%". `ratio` is a fraction (1 = 100%); one decimal, a trailing ".0" is dropped. */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "n/a";
  const pct = Math.round(ratio * 1000) / 10;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
function dayNumber(d: string): number | null {
  const m = ISO_DAY.exec(d);
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000) : null;
}

/**
 * Relative wording for a civil date: "today", "in 3 days", "2 days ago", "in 1 day", "1 day ago".
 * `todayISO` is the America/Toronto date (inject it; this function never reads the clock).
 * Returns "" when either date is not YYYY-MM-DD.
 */
export function formatDateRelative(dateISO: string, todayISO: string): string {
  const a = dayNumber(todayISO);
  const b = dayNumber(dateISO);
  if (a === null || b === null) return "";
  const d = b - a;
  if (d === 0) return "today";
  const n = Math.abs(d);
  const unit = n === 1 ? "day" : "days";
  return d > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}
