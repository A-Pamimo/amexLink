const INT = /^[+-]?\d+$/;

/**
 * Strict integer query param, clamped to [min, max]. Missing, empty, non-numeric
 * ("abc", "12abc", "1e3", "NaN") and unsafe-integer values all yield `def` (itself clamped),
 * never NaN, so a bad `limit` can no longer remove the LIMIT clause.
 */
export function intParam(
  sp: URLSearchParams,
  name: string,
  opts: { def: number; min: number; max: number }
): number {
  const clamp = (n: number) => Math.min(opts.max, Math.max(opts.min, n));
  const raw = sp.get(name)?.trim();
  if (!raw || !INT.test(raw)) return clamp(opts.def);
  const n = Number(raw);
  return Number.isSafeInteger(n) ? clamp(n) : clamp(opts.def);
}

/** Trimmed string query param; empty becomes undefined; over-long values are cut to `max` (default 200). */
export function strParam(
  sp: URLSearchParams,
  name: string,
  opts: { max?: number } = {}
): string | undefined {
  const raw = sp.get(name)?.trim();
  if (!raw) return undefined;
  return raw.slice(0, opts.max ?? 200);
}
