import { torontoToday } from "./cards/urgency";

export { torontoToday };

/** Month key (YYYY-MM) of the America/Toronto civil date at `d`. `d` is injectable for tests. */
export function torontoMonthKey(d: Date = new Date()): string {
  return torontoToday(d).slice(0, 7);
}

/** Shift a YYYY-MM key by `n` months (negative = earlier). Pure integer arithmetic, no time zone involved. */
export function shiftMonthKey(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** The last `n` month keys ending at Toronto's current month, oldest first. */
export function torontoMonthWindow(n: number, now: Date = new Date()): string[] {
  const current = torontoMonthKey(now);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftMonthKey(current, -i));
  return out;
}

function monthRange(key: string): { from: string; to: string } {
  const [y, m] = key.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${key}-01`, to: `${key}-${String(lastDay).padStart(2, "0")}` };
}

/** Whole current month in Toronto (first to last civil day). */
export function defaultRange(now: Date = new Date()): { from: string; to: string } {
  return monthRange(torontoMonthKey(now));
}

/** Whole previous month in Toronto. */
export function lastMonthRange(now: Date = new Date()): { from: string; to: string } {
  return monthRange(shiftMonthKey(torontoMonthKey(now), -1));
}
