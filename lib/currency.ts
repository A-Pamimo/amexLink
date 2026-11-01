/** Bucket for transactions whose provider gave no ISO currency code. Never formatted as money. */
export const UNKNOWN_CURRENCY = "UNKNOWN";

/** Valid `currency` query value: an upper-case ISO-4217-shaped code or `UNKNOWN`. */
export const CURRENCY_PARAM = /^[A-Z]{3}$|^UNKNOWN$/;

/** CAD first (the owner's home currency), other codes alphabetical, `UNKNOWN` last. Pure; returns a copy. */
export function sortCurrencies(codes: Iterable<string>): string[] {
  const rank = (c: string) => (c === "CAD" ? 0 : c === UNKNOWN_CURRENCY ? 2 : 1);
  return Array.from(new Set(codes)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** CAD when present, otherwise the first currency, otherwise undefined. */
export function defaultCurrency(currencies: readonly string[]): string | undefined {
  return currencies.includes("CAD") ? "CAD" : currencies[0];
}

export function isUnknownCurrency(currency: string | null | undefined): boolean {
  return !currency || currency === UNKNOWN_CURRENCY;
}
