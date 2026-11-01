import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole } from "../helpers/console";
import { closeApp, loadApp } from "../helpers/app";
import { installPlaidFake, plaidError } from "../helpers/plaid-fake";
import { req, seedItem } from "../helpers/seed";

const PLANTED = "access-sandbox-abc";

let con: ReturnType<typeof captureConsole>;
beforeEach(() => {
  con = captureConsole();
});
afterEach(() => {
  con.restore();
  closeApp();
});

function leakyError(code: string, status = 400) {
  return plaidError(code, {
    status,
    error_message: `request failed for ${PLANTED}`,
    requestBody: JSON.stringify({ access_token: PLANTED, public_token: "public-sandbox-zzz" }),
  });
}

describe("error bodies and logs carry no provider text or tokens", () => {
  it("link-token failure: generic code + provider_code only", async () => {
    const plaid = installPlaidFake();
    plaid.linkTokenCreate.mockRejectedValueOnce(leakyError("INVALID_FIELD"));
    await loadApp();
    const { POST } = await import("@/app/api/plaid/link-token/route");
    const res = await POST();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "provider_error", provider_code: "INVALID_FIELD" } });
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain("error_message");
    expect(con.text()).not.toContain(PLANTED);
    expect(con.text()).not.toContain("public-sandbox-zzz");
    expect(con.text()).not.toContain("secret-should-never-leak");
    // the allowlisted fields are what gets logged
    expect(con.text()).toContain("INVALID_FIELD");
    expect(con.text()).toContain("req_err_1");
  });

  it("exchange failure never leaks the planted token", async () => {
    const plaid = installPlaidFake();
    plaid.itemPublicTokenExchange.mockRejectedValueOnce(leakyError("INVALID_PUBLIC_TOKEN"));
    await loadApp();
    const { POST } = await import("@/app/api/plaid/exchange/route");
    const res = await POST(
      req("/api/plaid/exchange", { method: "POST", body: JSON.stringify({ public_token: "public-sandbox-q" }) })
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(PLANTED);
    expect(JSON.parse(text).error.provider_code).toBe("INVALID_PUBLIC_TOKEN");
    expect(con.text()).not.toContain(PLANTED);
  });

  it("sync failure never leaks the planted token", async () => {
    const plaid = installPlaidFake();
    plaid.transactionsSync.mockRejectedValue(leakyError("INTERNAL_SERVER_ERROR", 500));
    const { db } = await loadApp();
    await seedItem(db, { access_token: PLANTED });
    const { POST } = await import("@/app/api/plaid/sync/route");
    const one = await POST(req("/api/plaid/sync?item_id=plaid-item-1", { method: "POST" }));
    const all = await POST(req("/api/plaid/sync", { method: "POST" }));
    for (const res of [one, all]) {
      const text = await res.text();
      expect(text).not.toContain(PLANTED);
      expect(text).not.toContain("error_message");
    }
    expect(con.text()).not.toContain(PLANTED);
  });

  it.each([
    ["ITEM_LOGIN_REQUIRED", 409, "relink_required"],
    ["INVALID_ACCESS_TOKEN", 409, "relink_required"],
    ["ADDITIONAL_CONSENT_REQUIRED", 409, "consent_required"],
    ["RATE_LIMIT_EXCEEDED", 429, "rate_limited"],
    ["ITEM_NOT_FOUND", 404, "item_not_found"],
    ["SOMETHING_ELSE", 502, "provider_error"],
  ])("maps %s to HTTP %i / %s", async (provider, status, code) => {
    await loadApp();
    const { handleProviderError } = await import("@/lib/http/errors");
    const res = handleProviderError(plaidError(provider), { route: "test" });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { code, provider_code: provider } });
  });

  it("drops provider codes that are not enum-shaped and survives non-axios errors", async () => {
    await loadApp();
    const { handleProviderError } = await import("@/lib/http/errors");
    const weird = handleProviderError(plaidError(`bad code ${PLANTED}`), { route: "test" });
    expect(await weird.json()).toEqual({ error: { code: "provider_error" } });
    const plain = handleProviderError(new Error(`ECONNRESET ${PLANTED}`), { route: "test" });
    expect(plain.status).toBe(502);
    expect(JSON.stringify(await plain.json())).not.toContain(PLANTED);
    expect(con.text()).not.toContain(PLANTED);
  });
});

describe("log shim", () => {
  it("strips sensitive keys and token-looking values", async () => {
    await loadApp();
    const { logEvent } = await import("@/lib/http/log-shim");
    logEvent("x", {
      access_token: "a",
      PLAID_SECRET: "b",
      Cookie: "c",
      authorization: "d",
      password: "e",
      note: `hello ${PLANTED}`,
      item_id: "i1",
    });
    const out = con.text();
    expect(out).toContain('"item_id":"i1"');
    expect(out).toContain("[redacted]");
    for (const leaked of [PLANTED, '"a"', '"b"', '"c"', '"d"', '"e"']) expect(out).not.toContain(leaked);
  });
});

describe("health and system", () => {
  it("/api/health body is exactly { ok: true } and not cacheable", async () => {
    await loadApp();
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("/api/health is { ok: false } with 503 when the DB is unavailable", async () => {
    const { db } = await loadApp();
    db.ping = async () => {
      throw new Error("disk gone");
    };
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: false });
  });

  it("/api/system carries the operator detail", async () => {
    const { db } = await loadApp();
    await seedItem(db, { withTx: true });
    const { GET } = await import("@/app/api/system/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      db_ok: true,
      storage: "sqlite",
      auth_mode: "none",
      plaid_env: "sandbox",
      country_codes: ["US", "CA"],
      items_count: 1,
      tx_count: 1,
    });
  });
});
