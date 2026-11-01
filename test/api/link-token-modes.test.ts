import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { captureConsole } from "../helpers/console";
import { installPlaidFake, plaidError } from "../helpers/plaid-fake";
import { req, seedItem, SEED_TOKEN } from "../helpers/seed";

let con: ReturnType<typeof captureConsole>;
beforeEach(() => {
  con = captureConsole();
});
afterEach(() => {
  con.restore();
  closeApp();
});

const REDIRECT = "http://localhost:3000/plaid/oauth";

type LinkReq = Record<string, unknown> & { user: { client_user_id: string } };

async function setup(env: Record<string, string> = {}) {
  const plaid = installPlaidFake();
  const { db } = await loadApp(env);
  const { resetRateLimits } = await import("@/lib/http/rate-limit");
  resetRateLimits();
  const { POST } = await import("@/app/api/plaid/link-token/route");
  const call = (body?: unknown) =>
    POST(
      req("/api/plaid/link-token", {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );
  const lastRequest = () => plaid.linkTokenCreate.mock.calls.at(-1)![0] as LinkReq;
  return { plaid, db, call, lastRequest };
}

describe("POST /api/plaid/link-token modes", () => {
  it("new (default, no body): transactions + required_if_supported liabilities, credit-card filter, no webhook, no redirect_uri", async () => {
    const { call, lastRequest } = await setup();
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      link_token: "link-sandbox-fake",
      expiration: "2026-10-31T00:00:00Z",
      mode: "new",
    });

    const r = lastRequest();
    expect(r.products).toEqual(["transactions"]);
    expect(r.required_if_supported_products).toEqual(["liabilities"]);
    expect(r.account_filters).toEqual({ credit: { account_subtypes: ["credit card"] } });
    expect(r).not.toHaveProperty("webhook");
    expect(r).not.toHaveProperty("redirect_uri");
    expect(r).not.toHaveProperty("access_token");
    expect(r).not.toHaveProperty("additional_consented_products");
    expect(JSON.stringify(r)).not.toMatch(/"(auth|identity|investments|transfer|statements|balance)"/);
  });

  it("explicit mode:new behaves like the default", async () => {
    const { call, lastRequest } = await setup();
    expect((await call({ mode: "new" })).status).toBe(200);
    expect(lastRequest().products).toEqual(["transactions"]);
  });

  it("redirect_uri is sent only when PLAID_REDIRECT_URI is set, in every mode", async () => {
    const { call, lastRequest, db } = await setup({ PLAID_REDIRECT_URI: REDIRECT });
    await seedItem(db);

    await call({ mode: "new" });
    expect(lastRequest().redirect_uri).toBe(REDIRECT);
    await call({ mode: "consent", item_id: "plaid-item-1" });
    expect(lastRequest().redirect_uri).toBe(REDIRECT);
    await call({ mode: "repair", item_id: "plaid-item-1" });
    expect(lastRequest().redirect_uri).toBe(REDIRECT);
    expect(lastRequest()).not.toHaveProperty("webhook");
  });

  it("consent: access_token + additional_consented_products=[liabilities], NO products array", async () => {
    const { call, lastRequest, db } = await setup();
    await seedItem(db);
    const res = await call({ mode: "consent", item_id: "plaid-item-1" });
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe("consent");

    const r = lastRequest();
    expect(r.access_token).toBe(SEED_TOKEN);
    expect(r.additional_consented_products).toEqual(["liabilities"]);
    expect(r).not.toHaveProperty("products");
    expect(r).not.toHaveProperty("required_if_supported_products");
    expect(r).not.toHaveProperty("account_filters");
    expect(r).not.toHaveProperty("webhook");
    expect(Object.keys(r).sort()).toEqual(
      ["access_token", "additional_consented_products", "client_name", "country_codes", "language", "user"].sort()
    );
  });

  it("repair: access_token only, neither products nor additional_consented_products", async () => {
    const { call, lastRequest, db } = await setup();
    await seedItem(db);
    const res = await call({ mode: "repair", item_id: "plaid-item-1" });
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe("repair");

    const r = lastRequest();
    expect(r.access_token).toBe(SEED_TOKEN);
    expect(r).not.toHaveProperty("products");
    expect(r).not.toHaveProperty("additional_consented_products");
    expect(r).not.toHaveProperty("required_if_supported_products");
    expect(Object.keys(r).sort()).toEqual(["access_token", "client_name", "country_codes", "language", "user"].sort());
  });

  it("unknown item is 404 item_not_found and Plaid is not called", async () => {
    const { call, plaid } = await setup();
    for (const mode of ["consent", "repair"]) {
      const res = await call({ mode, item_id: "nope" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "item_not_found" } });
    }
    expect(plaid.linkTokenCreate).not.toHaveBeenCalled();
  });

  it("rejects bad input: unknown mode, missing item_id, non-JSON", async () => {
    const { call, plaid } = await setup();
    expect((await call({ mode: "delete" })).status).toBe(400);
    expect((await call({ mode: "consent" })).status).toBe(400);
    expect((await call({ mode: "repair", item_id: 5 })).status).toBe(400);
    const bad = await (await import("@/app/api/plaid/link-token/route")).POST(
      req("/api/plaid/link-token", { method: "POST", body: "{not json" })
    );
    expect(bad.status).toBe(400);
    expect(plaid.linkTokenCreate).not.toHaveBeenCalled();
  });

  it("client_user_id is the stable per-install id in every mode, never the old constant", async () => {
    const { call, lastRequest, db } = await setup();
    await seedItem(db);
    const ids: string[] = [];
    for (const body of [undefined, { mode: "consent", item_id: "plaid-item-1" }, { mode: "repair", item_id: "plaid-item-1" }]) {
      await call(body);
      ids.push(lastRequest().user.client_user_id);
    }
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe("amexlens-local-user");
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await db.getSetting("plaid_client_user_id")).toBe(ids[0]);
  });

  it("response never carries the access token, in any mode", async () => {
    const { call, db } = await setup();
    await seedItem(db);
    for (const body of [undefined, { mode: "consent", item_id: "plaid-item-1" }, { mode: "repair", item_id: "plaid-item-1" }]) {
      const text = await (await call(body)).text();
      expect(text).not.toContain(SEED_TOKEN);
      expect(text).not.toMatch(/access/);
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(["expiration", "link_token", "mode"]);
    }
  });

  it("a provider failure is mapped to a safe code and does not echo the token or provider text", async () => {
    const { call, plaid, db } = await setup();
    await seedItem(db);
    plaid.linkTokenCreate.mockRejectedValueOnce(
      plaidError("ITEM_LOGIN_REQUIRED", { status: 400, error_message: `bad ${SEED_TOKEN}`, requestBody: SEED_TOKEN })
    );
    const res = await call({ mode: "repair", item_id: "plaid-item-1" });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).not.toContain(SEED_TOKEN);
    expect(JSON.parse(text).error.code).toBe("relink_required");
    expect(con.text()).not.toContain(SEED_TOKEN);
  });
});
