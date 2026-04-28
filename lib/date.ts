import { endOfMonth, format, startOfMonth, subMonths } from "date-fns";

export function monthKey(d: Date): string {
  return format(d, "yyyy-MM");
}

export function isoDate(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

export function lastNMonths(n: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(monthKey(subMonths(now, i)));
  }
  return out;
}

export interface RangePreset {
  id: string;
  label: string;
  from: string;
  to: string;
}

export function rangePresets(now: Date = new Date()): RangePreset[] {
  const tm = startOfMonth(now);
  const lm = startOfMonth(subMonths(now, 1));
  return [
    {
      id: "this-month",
      label: "This month",
      from: isoDate(tm),
      to: isoDate(endOfMonth(now)),
    },
    {
      id: "last-month",
      label: "Last month",
      from: isoDate(lm),
      to: isoDate(endOfMonth(lm)),
    },
    {
      id: "30d",
      label: "Last 30 days",
      from: isoDate(subMonths(now, 1)),
      to: isoDate(now),
    },
    {
      id: "90d",
      label: "Last 90 days",
      from: isoDate(subMonths(now, 3)),
      to: isoDate(now),
    },
    {
      id: "ytd",
      label: "Year to date",
      from: isoDate(new Date(now.getFullYear(), 0, 1)),
      to: isoDate(now),
    },
  ];
}

export function defaultRange(): { from: string; to: string } {
  const now = new Date();
  return {
    from: isoDate(startOfMonth(now)),
    to: isoDate(endOfMonth(now)),
  };
}
