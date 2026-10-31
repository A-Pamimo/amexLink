import { describe, expect, it } from "vitest";
import { defaultCurrency, sortCurrencies } from "@/lib/currency";
import {
  defaultRange,
  lastMonthRange,
  shiftMonthKey,
  torontoMonthKey,
  torontoMonthWindow,
} from "@/lib/date";
import {
  currencyCaption,
  formatCurrency,
  formatDateRelative,
  formatPercent,
  formatTimestampToronto,
} from "@/lib/format";

describe("formatCurrency", () => {
  it("requires a currency (type-level) and has no USD default", () => {
    // @ts-expect-error currency is a required parameter
    const out = formatCurrency(5);
    // A missing currency is treated as unknown at runtime: a plain number, never "$".
    expect(out).toBe("5.00");
  });

  it("formats with the given currency", () => {
    expect(formatCurrency(1234.5, "CAD")).toMatch(/1,234\.50/);
    expect(formatCurrency(1234.5, "CAD")).not.toBe(formatCurrency(1234.5, "USD"));
    expect(formatCurrency(5, "EUR")).toContain("€");
  });

  it("renders UNKNOWN and null as a plain number with a caption", () => {
    for (const c of ["UNKNOWN", null]) {
      expect(formatCurrency(1234.5, c)).toBe("1,234.50");
      expect(currencyCaption(c)).toBe("currency unknown");
    }
    expect(currencyCaption("CAD")).toBeUndefined();
  });
});

describe("currency helpers", () => {
  it("sorts CAD first and UNKNOWN last", () => {
    expect(sortCurrencies(["USD", "UNKNOWN", "EUR", "CAD", "USD"])).toEqual([
      "CAD",
      "EUR",
      "USD",
      "UNKNOWN",
    ]);
  });

  it("defaults to CAD when present, else the first", () => {
    expect(defaultCurrency(["EUR", "CAD"])).toBe("CAD");
    expect(defaultCurrency(["USD", "EUR"])).toBe("USD");
    expect(defaultCurrency([])).toBeUndefined();
  });
});

describe("Toronto month helpers", () => {
  it("derives the month key from the Toronto civil date", () => {
    expect(torontoMonthKey(new Date("2026-03-01T03:30:00Z"))).toBe("2026-02");
    expect(torontoMonthKey(new Date("2026-03-01T05:00:00Z"))).toBe("2026-03");
  });

  it("shifts month keys across year boundaries", () => {
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
    expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
    expect(shiftMonthKey("2026-03", -14)).toBe("2025-01");
  });

  it("builds windows and ranges from Toronto's today", () => {
    const now = new Date("2026-03-01T03:30:00Z");
    expect(torontoMonthWindow(3, now)).toEqual(["2025-12", "2026-01", "2026-02"]);
    expect(defaultRange(now)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(lastMonthRange(now)).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(defaultRange(new Date("2028-03-15T12:00:00Z")).to).toBe("2028-03-31");
    expect(lastMonthRange(new Date("2028-03-15T12:00:00Z")).to).toBe("2028-02-29");
  });
});

describe("formatPercent", () => {
  it("formats a ratio with at most one decimal", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.2)).toBe("20%");
    expect(formatPercent(0.2345)).toBe("23.5%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(1.234)).toBe("123.4%");
  });

  it("does not print NaN or Infinity", () => {
    expect(formatPercent(Number.NaN)).toBe("n/a");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("n/a");
  });
});

describe("formatDateRelative (today is injected, never read from the clock)", () => {
  const today = "2026-10-31";
  it("today, tomorrow, a week out, yesterday", () => {
    expect(formatDateRelative("2026-10-31", today)).toBe("today");
    expect(formatDateRelative("2026-11-01", today)).toBe("in 1 day");
    expect(formatDateRelative("2026-11-03", today)).toBe("in 3 days");
    expect(formatDateRelative("2026-11-07", today)).toBe("in 7 days");
    expect(formatDateRelative("2026-10-30", today)).toBe("1 day ago");
    expect(formatDateRelative("2026-10-29", today)).toBe("2 days ago");
  });

  it("counts civil days across month, year and leap-day boundaries", () => {
    expect(formatDateRelative("2027-01-02", "2026-12-31")).toBe("in 2 days");
    expect(formatDateRelative("2028-03-01", "2028-02-28")).toBe("in 2 days");
    expect(formatDateRelative("2026-11-01", "2026-03-08")).toBe("in 238 days"); // DST never shifts a civil date
  });

  it("returns an empty string for anything that is not YYYY-MM-DD", () => {
    expect(formatDateRelative("soon", today)).toBe("");
    expect(formatDateRelative("2026-10-31", "")).toBe("");
  });
});

describe("formatTimestampToronto", () => {
  it("shows the America/Toronto wall time", () => {
    expect(formatTimestampToronto("2026-10-31T12:00:00.000Z")).toBe("2026-10-31 08:00"); // EDT
    expect(formatTimestampToronto("2026-12-31T05:30:00.000Z")).toBe("2026-12-31 00:30"); // EST, midnight hour is 00
    expect(formatTimestampToronto("nope")).toBe("");
  });
});
