import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { req, seedItem } from "../helpers/seed";
import type { TransactionInsert } from "@/lib/db";

afterEach(() => closeApp());

const sp = (q: string) => new URLSearchParams(q);

describe("intParam / strParam", () => {
  it("clamps and defaults", async () => {
    const { intParam, strParam } = await import("@/lib/http/params");
    const o = { def: 200, min: 1, max: 1000 };
    expect(intParam(sp(""), "limit", o)).toBe(200);
    expect(intParam(sp("limit="), "limit", o)).toBe(200);
    expect(intParam(sp("limit=abc"), "limit", o)).toBe(200);
    expect(intParam(sp("limit=NaN"), "limit", o)).toBe(200);
    expect(intParam(sp("limit=12abc"), "limit", o)).toBe(200);
    expect(intParam(sp("limit=1e3"), "limit", o)).toBe(200);
    expect(intParam(sp("limit=1.5"), "limit", o)).toBe(200);
    expect(intParam(sp("limit=99999999999999999999"), "limit", o)).toBe(200);
    expect(intParam(sp("limit=50"), "limit", o)).toBe(50);
    expect(intParam(sp("limit=0"), "limit", o)).toBe(1);
    expect(intParam(sp("limit=-5"), "limit", o)).toBe(1);
    expect(intParam(sp("limit=5000"), "limit", o)).toBe(1000);
    expect(intParam(sp("offset=-1"), "offset", { def: 0, min: 0, max: 10 })).toBe(0);

    expect(strParam(sp("q=%20%20"), "q")).toBeUndefined();
    expect(strParam(sp("q=%20hi%20"), "q")).toBe("hi");
    expect(strParam(sp(`q=${"x".repeat(500)}`), "q", { max: 10 })).toBe("x".repeat(10));
  });
});

function txRow(i: number, name = `ROW ${i}`): TransactionInsert {
  return {
    id: `tx-${String(i).padStart(4, "0")}`,
    account_id: "acc",
    item_id: "plaid-item-1",
    name,
    amount: 1,
    iso_currency_code: "CAD",
    date: "2026-10-01",
    plaid_category: null,
    plaid_category_detailed: null,
    merchant_name: null,
    logo_url: null,
    bucket: "other",
    pending: false,
  };
}

describe("GET /api/transactions", () => {
  it("a non-numeric limit falls back to 200 rows instead of removing the LIMIT", async () => {
    const { db } = await loadApp();
    await seedItem(db);
    await db.upsertAddedTransactions(Array.from({ length: 250 }, (_, i) => txRow(i)));
    const { GET } = await import("@/app/api/transactions/route");
    const rows = async (q: string) =>
      ((await (await GET(req(`/api/transactions${q}`))).json()) as { transactions: unknown[] }).transactions
        .length;

    expect(await rows("")).toBe(200);
    expect(await rows("?limit=abc")).toBe(200);
    expect(await rows("?limit=NaN")).toBe(200);
    expect(await rows("?limit=10")).toBe(10);
    expect(await rows("?limit=0")).toBe(1);
    expect(await rows("?limit=999999")).toBe(250);
    expect(await rows("?limit=abc&offset=200")).toBe(50);
    expect(await rows("?offset=junk")).toBe(200);
  });

  it("LIKE metacharacters in q match literally", async () => {
    const { db } = await loadApp();
    await seedItem(db);
    await db.upsertAddedTransactions([
      txRow(1, "100% CASHBACK"),
      txRow(2, "1000 STEPS"),
      txRow(3, "A_B STORE"),
      txRow(4, "AXB STORE"),
      txRow(5, "BACK\\SLASH"),
      txRow(6, "BACKSLASH"),
    ]);
    const { GET } = await import("@/app/api/transactions/route");
    const names = async (q: string) =>
      ((await (await GET(req(`/api/transactions?q=${encodeURIComponent(q)}`))).json()) as {
        transactions: Array<{ name: string }>;
      }).transactions
        .map((t) => t.name)
        .sort();

    expect(await names("100%")).toEqual(["100% CASHBACK"]);
    expect(await names("A_B")).toEqual(["A_B STORE"]);
    expect(await names("\\")).toEqual(["BACK\\SLASH"]);
    expect(await names("%")).toEqual(["100% CASHBACK"]);
    expect(await names("cash")).toEqual(["100% CASHBACK"]); // plain substring, case-insensitive, still works
  });
});

describe("GET /api/stats/trend", () => {
  it("clamps months and falls back to 6 for junk", async () => {
    await loadApp();
    const { GET } = await import("@/app/api/stats/trend/route");
    const months = async (q: string) => ((await (await GET(req(`/api/stats/trend${q}`))).json()) as { months: number }).months;
    expect(await months("")).toBe(6);
    expect(await months("?months=abc")).toBe(6);
    expect(await months("?months=0")).toBe(1);
    expect(await months("?months=99")).toBe(24);
    expect(await months("?months=12")).toBe(12);
  });
});
