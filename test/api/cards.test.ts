import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CardsResponse } from "@/lib/cards/view";
import type { ProviderCard } from "@/lib/providers/types";
import { closeApp, loadApp } from "../helpers/app";
import { captureConsole } from "../helpers/console";
import { makeCard, ob, present } from "../helpers/cards";
import { installPlaidFake, plaidError } from "../helpers/plaid-fake";
import { req, seedItem } from "../helpers/seed";

let con: ReturnType<typeof captureConsole>;
beforeEach(() => {
  con = captureConsole();
});
afterEach(() => {
  con.restore();
  closeApp();
});

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function store(db: Awaited<ReturnType<typeof loadApp>>["db"], item_id: string, cards: ProviderCard[]) {
  const ids = await db.upsertAccounts(item_id, "plaid", cards);
  for (const c of cards) await db.replaceAccountFields(ids[c.provider_account_id], "plaid", c.fields);
  return ids;
}

describe("GET /api/cards", () => {
  it("returns per-currency totals that are never summed across currencies; excluded counts cards without a limit", async () => {
    const { db } = await loadApp();
    const item = await seedItem(db);
    await store(db, item.item_id, [
      makeCard("cad-a", { mask: "1005" }, { current_balance: present(1000), credit_limit: present(5000), statement_balance: present(800) }),
      makeCard("cad-b", { mask: "2222" }, { current_balance: present(500), credit_limit: ob("not_supplied"), statement_balance: present(400) }),
      makeCard("usd-c", { mask: "4321", iso_currency_code: "USD" }, { current_balance: present(200), credit_limit: present(1000), statement_balance: present(150) }),
    ]);

    const { GET } = await import("@/app/api/cards/route");
    const res = await GET(req("/api/cards"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CardsResponse;

    expect(Object.keys(body.totals_by_currency)).toEqual(["CAD", "USD"]);
    expect(body.totals_by_currency.CAD).toEqual({
      balance: 1500,
      statement_due: 1200,
      utilization: { ratio: 0.2, included: 1, excluded: 1 },
    });
    expect(body.totals_by_currency.USD).toEqual({
      balance: 200,
      statement_due: 150,
      utilization: { ratio: 0.2, included: 1, excluded: 0 },
    });
    expect(body.cards).toHaveLength(3);
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(body.generated_at).toISOString()).toBe(body.generated_at);
  });

  it("totals are null (not 0) when no card has the value, and a currency-less card gets its own bucket", async () => {
    const { db } = await loadApp();
    const item = await seedItem(db);
    await store(db, item.item_id, [
      makeCard("x", { iso_currency_code: null }, { current_balance: ob("error", null, { error_code: "X" }), statement_balance: ob("not_supported"), credit_limit: ob("not_supplied") }),
    ]);
    const { GET } = await import("@/app/api/cards/route");
    const body = (await (await GET(req("/api/cards"))).json()) as CardsResponse;
    expect(body.totals_by_currency).toEqual({
      UNKNOWN: { balance: null, statement_due: null, utilization: { ratio: null, included: 0, excluded: 1 } },
    });
  });

  it("sorts by urgency then date, adds urgency + days_until_due, and counts overdue / due_soon", async () => {
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { torontoToday } = await import("@/lib/cards/urgency");
    const today = torontoToday();
    await store(db, item.item_id, [
      makeCard("unknown", { mask: "0001" }, { next_payment_due_date: ob("not_supplied"), is_overdue: ob("not_supplied") }),
      makeCard("sched", { mask: "0002" }, { next_payment_due_date: present(addDays(today, 30)) }),
      makeCard("soon", { mask: "0003" }, { next_payment_due_date: present(addDays(today, 3)) }),
      makeCard("overdue", { mask: "0004" }, { next_payment_due_date: present(addDays(today, 10)), is_overdue: present(true) }),
      makeCard("past", { mask: "0005" }, { next_payment_due_date: present(addDays(today, -2)), is_overdue: present(false) }),
    ]);
    const { GET } = await import("@/app/api/cards/route");
    const body = (await (await GET(req("/api/cards"))).json()) as CardsResponse;
    expect(body.cards.map((c) => c.mask)).toEqual(["0004", "0003", "0002", "0005", "0001"]);
    expect(body.cards.map((c) => c.urgency)).toEqual(["overdue", "due_soon", "scheduled", "past_not_overdue", "unknown"]);
    expect(body.cards.map((c) => c.days_until_due)).toEqual([10, 3, 30, -2, null]);
    expect(body.counts).toEqual({ overdue: 1, due_soon: 1 });
  });

  it("exposes provenance per field and no token, cursor or account numbers", async () => {
    const plaid = installPlaidFake();
    plaid.liabilitiesGet.mockRejectedValueOnce(plaidError("PRODUCTS_NOT_SUPPORTED", { status: 400 }));
    const { db } = await loadApp();
    const item = await seedItem(db);
    await db.updateItemSync(item.item_id, "cursor-secret-1", "2026-10-31T00:00:00.000Z");
    const { refreshItemCards } = await import("@/lib/cards/refresh");
    await refreshItemCards(item.item_id);

    const { GET } = await import("@/app/api/cards/route");
    const text = await (await GET(req("/api/cards"))).text();
    const body = JSON.parse(text) as CardsResponse;
    const amex = body.cards.find((c) => c.mask === "1005");
    expect(amex?.fields.current_balance).toMatchObject({ status: "present", provider: "plaid" });
    expect(amex?.fields.minimum_payment).toMatchObject({
      status: "not_supported",
      provider: "plaid",
      error_code: "PRODUCTS_NOT_SUPPORTED",
    });
    expect(amex?.liabilities_status).toBe("not_supported");
    expect(amex?.last_synced_at).toBe("2026-10-31T00:00:00.000Z");
    for (const bad of ["access-sandbox", "cursor-secret-1", "371449635398431", "123456789", "Pat Example", "access_token"]) {
      expect(text).not.toContain(bad);
    }
  });

  it("returns an empty overview when nothing is linked", async () => {
    await loadApp();
    const { GET } = await import("@/app/api/cards/route");
    const body = (await (await GET(req("/api/cards"))).json()) as CardsResponse;
    expect(body).toMatchObject({ cards: [], totals_by_currency: {}, counts: { overdue: 0, due_soon: 0 } });
  });
});

describe("POST /api/cards/[id]/refresh", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const post = () => new Request("http://localhost/api/cards/x/refresh", { method: "POST" });

  async function boot() {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { resetRateLimits } = await import("@/lib/http/rate-limit");
    resetRateLimits();
    const { refreshItemCards } = await import("@/lib/cards/refresh");
    await refreshItemCards(item.item_id, { realtimeBalance: false });
    const row = (await db.listCardRows()).find((r) => r.mask === "1005")!;
    return { plaid, db, item, row };
  }

  it("is the only caller of /accounts/balance/get; a second call within 10 minutes is 429", async () => {
    const { plaid, row } = await boot();
    // The sync-style (non-realtime) refresh above used the free cached call only.
    expect(plaid.accountsGet).toHaveBeenCalledTimes(1);
    expect(plaid.accountsBalanceGet).not.toHaveBeenCalled();

    const { POST } = await import("@/app/api/cards/[id]/refresh/route");
    const res = await POST(post(), ctx(row.id));
    expect(res.status).toBe(200);
    expect(plaid.accountsBalanceGet).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as {
      card: { id: string; fields: Record<string, { value: unknown }> };
      refresh: { balance_source: string; liabilities_status: string };
    };
    expect(body.refresh).toMatchObject({ balance_source: "realtime", liabilities_status: "ok" });
    expect(body.card.id).toBe(row.id);
    expect(body.card.fields.current_balance.value).toBe(2000); // from the realtime fixture

    const again = await POST(post(), ctx(row.id));
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(plaid.accountsBalanceGet).toHaveBeenCalledTimes(1); // no billed call on the rejected request
  });

  it("falls back to cached balances and says so when the live call fails", async () => {
    const { plaid, row } = await boot();
    plaid.accountsBalanceGet.mockRejectedValueOnce(plaidError("PRODUCT_NOT_READY", { status: 400 }));
    const { POST } = await import("@/app/api/cards/[id]/refresh/route");
    const res = await POST(post(), ctx(row.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh: { balance_source: string }; card: { fields: Record<string, { value: unknown }> } };
    expect(body.refresh.balance_source).toBe("cached");
    expect(body.card.fields.current_balance.value).toBe(1500.18);
  });

  it("maps a total provider failure to a sanitized error and keeps stored cards", async () => {
    const { plaid, db, row } = await boot();
    plaid.accountsBalanceGet.mockRejectedValueOnce(plaidError("INTERNAL_SERVER_ERROR", { status: 500 }));
    plaid.accountsGet.mockRejectedValueOnce(
      plaidError("ITEM_LOGIN_REQUIRED", { status: 400, error_message: "secret 371449635398431" })
    );
    const { POST } = await import("@/app/api/cards/[id]/refresh/route");
    const res = await POST(post(), ctx(row.id));
    const text = await res.text();
    expect(res.status).toBe(409);
    expect(JSON.parse(text)).toEqual({ error: { code: "relink_required", provider_code: "ITEM_LOGIN_REQUIRED" } });
    expect(text).not.toContain("371449635398431");
    expect((await db.listCardRows()).find((r) => r.id === row.id)?.fields.current_balance?.value).toBe(1500.18);
  });

  it("404 for an unknown or malformed id, without consuming a rate-limit slot or calling Plaid", async () => {
    const { plaid } = await boot();
    const { POST } = await import("@/app/api/cards/[id]/refresh/route");
    for (const id of ["does-not-exist", "../../etc", "x".repeat(200)]) {
      const res = await POST(post(), ctx(id));
      expect(res.status).toBe(404);
    }
    expect(plaid.accountsBalanceGet).not.toHaveBeenCalled();
    const { rateLimit } = await import("@/lib/http/rate-limit");
    expect(rateLimit("balance:does-not-exist", 1, 60_000).ok).toBe(true);
  });
});
