import { describe, expect, it } from "vitest";
import { defaultCurrency, sortCurrencies } from "@/lib/currency";
import {
  defaultRange,
  lastMonthRange,
  shiftMonthKey,
  torontoMonthKey,
  torontoMonthWindow,
} from "@/lib/date";
import { currencyCaption, formatCurrency } from "@/lib/format";

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
