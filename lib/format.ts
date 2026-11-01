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
