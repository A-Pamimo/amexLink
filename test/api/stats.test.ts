import { afterEach, describe, expect, it } from "vitest";
import { defaultRange } from "@/lib/date";
import { closeApp, loadApp } from "../helpers/app";
import { req, seedItem } from "../helpers/seed";
import { tx } from "../helpers/tx";

afterEach(() => closeApp());

async function seeded() {
  const { db } = await loadApp();
  await seedItem(db);
  const month = defaultRange().from.slice(0, 7);
  await db.upsertAddedTransactions([
    tx({ amount: 10, iso_currency_code: "CAD", date: `${month}-02` }),
    tx({ amount: 6, iso_currency_code: "CAD", bucket: "travel", date: `${month}-02` }),
    tx({ amount: 7, iso_currency_code: "USD", date: `${month}-02` }),
  ]);
  return { db, month };
}

describe("GET /api/stats/totals", () => {
  it("returns per-currency byBucket and grandTotal, with no top-level combined keys", async () => {
    await seeded();
    const { GET } = await import("@/app/api/stats/totals/route");
    const res = await GET(req("/api/stats/totals"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const range = defaultRange();
    expect(body).toEqual({
      from: range.from,
      to: range.to,
      currencies: ["CAD", "USD"],
      byCurrency: {
        CAD: { byBucket: { food: 10, travel: 6 }, grandTotal: 16 },
        USD: { byBucket: { food: 7 }, grandTotal: 7 },
      },
    });
    expect(body).not.toHaveProperty("grandTotal");
    expect(body).not.toHaveProperty("byBucket");
  });

  it("returns only the requested currency, but still lists all currencies", async () => {
    await seeded();
    const { GET } = await import("@/app/api/stats/totals/route");
    const body = await (await GET(req("/api/stats/totals?currency=USD"))).json();
    expect(body.currencies).toEqual(["CAD", "USD"]);
    expect(body.byCurrency).toEqual({ USD: { byBucket: { food: 7 }, grandTotal: 7 } });
    const none = await (await GET(req("/api/stats/totals?currency=EUR"))).json();
    expect(none.byCurrency).toEqual({ EUR: { byBucket: {}, grandTotal: 0 } });
  });

  it.each(["usd", "US", "USDD", "UNKNOWN1", "C%20AD", "1AD", "unknown"])(
    "rejects currency=%s with 400",
    async (c) => {
      await seeded();
      const { GET } = await import("@/app/api/stats/totals/route");
      const res = await GET(req(`/api/stats/totals?currency=${c}`));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid currency" });
    }
  );

  it("accepts UNKNOWN", async () => {
    await seeded();
    const { GET } = await import("@/app/api/stats/totals/route");
    expect((await GET(req("/api/stats/totals?currency=UNKNOWN"))).status).toBe(200);
  });
});

describe("GET /api/stats/trend", () => {
  it("returns months, currencies and a series per currency", async () => {
    const { month } = await seeded();
    const { GET } = await import("@/app/api/stats/trend/route");
    const res = await GET(req("/api/stats/trend?months=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.months).toBe(2);
    expect(body.currencies).toEqual(["CAD", "USD"]);
    expect(body).not.toHaveProperty("trend");
    expect(body.byCurrency.CAD).toHaveLength(2);
    expect(body.byCurrency.CAD[1]).toMatchObject({ month, total: 16 });
    expect(body.byCurrency.USD[1]).toMatchObject({ month, total: 7 });
  });

  it("filters to one currency", async () => {
    await seeded();
    const { GET } = await import("@/app/api/stats/trend/route");
    const body = await (await GET(req("/api/stats/trend?months=2&currency=CAD"))).json();
    expect(Object.keys(body.byCurrency)).toEqual(["CAD"]);
    expect(body.currencies).toEqual(["CAD", "USD"]);
  });

  it("rejects an invalid currency with 400", async () => {
    await seeded();
    const { GET } = await import("@/app/api/stats/trend/route");
    expect((await GET(req("/api/stats/trend?currency=usd"))).status).toBe(400);
    expect((await GET(req("/api/stats/trend?currency=CAD;DROP"))).status).toBe(400);
  });
});

describe("GET /api/stats/currencies", () => {
  it("lists currencies with CAD first", async () => {
    await seeded();
    const { GET } = await import("@/app/api/stats/currencies/route");
    expect(await (await GET()).json()).toEqual({ currencies: ["CAD", "USD"] });
  });

  it("is empty with no transactions", async () => {
    await loadApp();
    const { GET } = await import("@/app/api/stats/currencies/route");
    expect(await (await GET()).json()).toEqual({ currencies: [] });
  });
});
