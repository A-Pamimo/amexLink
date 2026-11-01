import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { seedItem } from "../helpers/seed";
import { tx } from "../helpers/tx";

afterEach(() => closeApp());

async function setup() {
  const { db } = await loadApp();
  await seedItem(db);
  return db;
}

describe("bucketTotals (per currency)", () => {
  it("keeps CAD and USD in the same bucket and month separate, with no combined figure", async () => {
    const db = await setup();
    await db.upsertAddedTransactions([
      tx({ amount: 10, iso_currency_code: "CAD", bucket: "food" }),
      tx({ amount: 15, iso_currency_code: "CAD", bucket: "food" }),
      tx({ amount: 7, iso_currency_code: "USD", bucket: "food" }),
      tx({ amount: 3, iso_currency_code: "USD", bucket: "travel" }),
    ]);
    const r = await db.bucketTotals({ from: "2026-10-01", to: "2026-10-31" });
    expect(r.byCurrency).toEqual({
      CAD: { food: 25 },
      USD: { food: 7, travel: 3 },
    });
    expect(r.currencies).toEqual(["CAD", "USD"]);
    // No key holds a mixed sum: the only keys are currency codes.
    expect(Object.keys(r.byCurrency).sort()).toEqual(["CAD", "USD"]);
    expect(r).not.toHaveProperty("grandTotal");
    expect(r).not.toHaveProperty("byBucket");
  });

  it("groups a missing or empty currency code under UNKNOWN, sorted last", async () => {
    const db = await setup();
    await db.upsertAddedTransactions([
      tx({ amount: 1, iso_currency_code: null }),
      tx({ amount: 2, iso_currency_code: "" }),
      tx({ amount: 4, iso_currency_code: "EUR" }),
      tx({ amount: 8, iso_currency_code: "CAD" }),
    ]);
    const r = await db.bucketTotals({ from: "2026-10-01", to: "2026-10-31" });
    expect(r.byCurrency.UNKNOWN).toEqual({ food: 3 });
    expect(r.currencies).toEqual(["CAD", "EUR", "UNKNOWN"]);
  });

  it("still honours pending, range and non-spending filters", async () => {
    const db = await setup();
    await db.upsertAddedTransactions([
      tx({ amount: 10 }),
      tx({ amount: 99, pending: true }),
      tx({ amount: 50, date: "2026-09-30" }),
      tx({ amount: -200, bucket: "income" }),
    ]);
    const range = { from: "2026-10-01", to: "2026-10-31" };
    expect((await db.bucketTotals(range)).byCurrency).toEqual({ CAD: { food: 10 } });
    const inc = await db.bucketTotals({ ...range, include_non_spending: true });
    expect(inc.byCurrency.CAD).toEqual({ food: 10, income: -200 });
  });
});

describe("monthlyTrend (per currency)", () => {
  const NOW = new Date("2026-10-20T16:00:00Z");

  it("returns one aligned series per currency", async () => {
    const db = await setup();
    await db.upsertAddedTransactions([
      tx({ amount: 10, iso_currency_code: "CAD", date: "2026-10-05" }),
      tx({ amount: 20, iso_currency_code: "CAD", date: "2026-09-05" }),
      tx({ amount: 5, iso_currency_code: "USD", date: "2026-10-06" }),
    ]);
    const r = await db.monthlyTrend(3, undefined, false, undefined, NOW);
    expect(r.currencies).toEqual(["CAD", "USD"]);
    expect(Object.keys(r.byCurrency)).toEqual(["CAD", "USD"]);
    expect(r.byCurrency.CAD.map((p) => [p.month, p.total])).toEqual([
      ["2026-08", 0],
      ["2026-09", 20],
      ["2026-10", 10],
    ]);
    expect(r.byCurrency.USD.map((p) => [p.month, p.total])).toEqual([
      ["2026-08", 0],
      ["2026-09", 0],
      ["2026-10", 5],
    ]);
    expect(r.byCurrency.USD[2].byBucket.food).toBe(5);
    expect(r.byCurrency.USD[2].byBucket.travel).toBe(0);
  });

  it("returns only the requested currency (still inside byCurrency), zero-filled when it has no rows", async () => {
    const db = await setup();
    await db.upsertAddedTransactions([
      tx({ amount: 10, iso_currency_code: "CAD" }),
      tx({ amount: 5, iso_currency_code: "USD" }),
    ]);
    const usd = await db.monthlyTrend(2, undefined, false, "USD", NOW);
    expect(Object.keys(usd.byCurrency)).toEqual(["USD"]);
    expect(usd.byCurrency.USD[1].total).toBe(5);
    expect(usd.currencies).toEqual(["CAD", "USD"]);

    const eur = await db.monthlyTrend(2, undefined, false, "EUR", NOW);
    expect(Object.keys(eur.byCurrency)).toEqual(["EUR"]);
    expect(eur.byCurrency.EUR.map((p) => p.total)).toEqual([0, 0]);
  });

  it("builds the month window from Toronto's current month, not the server clock", async () => {
    const db = await setup();
    // 2026-03-01T03:30Z is still Feb 28 in Toronto (UTC-5): the window ends in February.
    const early = await db.monthlyTrend(3, undefined, false, "CAD", new Date("2026-03-01T03:30:00Z"));
    expect(early.byCurrency.CAD.map((p) => p.month)).toEqual(["2025-12", "2026-01", "2026-02"]);
    const after = await db.monthlyTrend(3, undefined, false, "CAD", new Date("2026-03-01T12:00:00Z"));
    expect(after.byCurrency.CAD.map((p) => p.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    // Year boundary: 2026-01-01T03:00Z is still Dec 31 in Toronto.
    const y = await db.monthlyTrend(2, undefined, false, "CAD", new Date("2026-01-01T03:00:00Z"));
    expect(y.byCurrency.CAD.map((p) => p.month)).toEqual(["2025-11", "2025-12"]);
    // DST end (Nov 1 2026): 03:30Z is Oct 31 in Toronto.
    const dst = await db.monthlyTrend(1, undefined, false, "CAD", new Date("2026-11-01T03:30:00Z"));
    expect(dst.byCurrency.CAD.map((p) => p.month)).toEqual(["2026-10"]);
  });

  it("groups a transaction by its own date column, never by a time-zone conversion", async () => {
    const db = await setup();
    await db.upsertAddedTransactions([
      tx({ amount: 11, date: "2026-03-01" }),
      tx({ amount: 22, date: "2026-02-28" }),
    ]);
    // At 2026-03-01T12:00Z Toronto is in March, so both months are in the window; the
    // 03-01 row is March and the 02-28 row February, exactly as their date strings say.
    const r = await db.monthlyTrend(2, undefined, false, "CAD", new Date("2026-03-01T12:00:00Z"));
    expect(r.byCurrency.CAD.map((p) => [p.month, p.total])).toEqual([
      ["2026-02", 22],
      ["2026-03", 11],
    ]);
    // At 2026-03-01T03:30:00Z Toronto is still Feb 28: the window ends in February, so the
    // March-dated row is outside it (it is not shifted back into February).
    const early = await db.monthlyTrend(2, undefined, false, "CAD", new Date("2026-03-01T03:30:00Z"));
    expect(early.byCurrency.CAD.map((p) => [p.month, p.total])).toEqual([
      ["2026-01", 0],
      ["2026-02", 22],
    ]);
  });
});

describe("listCurrencies", () => {
  it("is empty without transactions", async () => {
    const db = await setup();
    expect(await db.listCurrencies()).toEqual([]);
  });

  it("returns distinct codes sorted with CAD first", async () => {
    const db = await setup();
    await db.upsertAddedTransactions([
      tx({ iso_currency_code: "USD" }),
      tx({ iso_currency_code: "EUR" }),
      tx({ iso_currency_code: "USD" }),
      tx({ iso_currency_code: "CAD" }),
    ]);
    expect(await db.listCurrencies()).toEqual(["CAD", "EUR", "USD"]);
  });

  it("lists UNKNOWN (last) when some rows have no code, and omits CAD when absent", async () => {
    const db = await setup();
    await db.upsertAddedTransactions([
      tx({ iso_currency_code: null }),
      tx({ iso_currency_code: "USD" }),
    ]);
    expect(await db.listCurrencies()).toEqual(["USD", "UNKNOWN"]);
  });
});
