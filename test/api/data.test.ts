import Database from "better-sqlite3";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { REQUIRED_ENV, COOKIE_NAME, makeReq } from "../helpers/auth";
import { makeCard } from "../helpers/cards";
import { captureConsole } from "../helpers/console";
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

type TestDB = Awaited<ReturnType<typeof loadApp>>["db"];

const TOKEN_A = "access-sandbox-aaa";
const TOKEN_B = "access-sandbox-bbb";

/** Two items, each with an account, its field observations and one transaction. */
async function seedTwo(db: TestDB) {
  await seedItem(db, { id: "row-a", item_id: "plaid-item-a", access_token: TOKEN_A, withTx: true });
  await seedItem(db, { id: "row-b", item_id: "plaid-item-b", access_token: TOKEN_B, withTx: true });
  for (const [item, pa, mask] of [
    ["plaid-item-a", "pa-a", "1005"],
    ["plaid-item-b", "pa-b", "2222"],
  ] as const) {
    const card = makeCard(pa, { mask });
    const ids = await db.upsertAccounts(item, "plaid", [card]);
    await db.replaceAccountFields(ids[pa], "plaid", card.fields);
  }
  await db.setSetting("plaid_client_user_id", "client-user-1");
  await db.setSetting("some_cache", "x");
}

function raw<T>(dir: string, sql: string): T[] {
  const h = new Database(path.join(dir, "test.sqlite"), { readonly: true });
  try {
    return h.prepare(sql).all() as T[];
  } finally {
    h.close();
  }
}

const count = (dir: string, table: string) =>
  raw<{ n: number }>(dir, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;

describe("DELETE /api/data (delete all local data)", () => {
  it("revokes every item, wipes card data in one go, keeps security_log and the client_user_id", async () => {
    const plaid = installPlaidFake();
    const { db, dir } = await loadApp();
    await seedTwo(db);

    const { DELETE } = await import("@/app/api/data/route");
    const res = await DELETE(req("/api/data", { method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; results: Array<{ item_id: string; ok: boolean }> };
    expect(body.ok).toBe(true);
    expect(body.results.map((r) => r.item_id).sort()).toEqual(["plaid-item-a", "plaid-item-b"]);
    expect(body.results.every((r) => r.ok)).toBe(true);
    expect(plaid.itemRemove).toHaveBeenCalledTimes(2);

    for (const t of ["transactions", "account_fields", "accounts", "plaid_items"]) {
      expect(count(dir, t), t).toBe(0);
    }
    expect(raw<{ key: string }>(dir, "SELECT key FROM settings")).toEqual([{ key: "plaid_client_user_id" }]);

    const log = raw<{ event: string; outcome: string | null; detail: string | null }>(
      dir,
      "SELECT event, outcome, detail FROM security_log WHERE event = 'data_delete_all'"
    );
    expect(log).toHaveLength(1);
    expect(log[0].outcome).toBe("ok");
    // The audit trail is kept: the per-item revoke rows are still there too.
    expect(raw(dir, "SELECT 1 FROM security_log WHERE event = 'revoke'")).toHaveLength(2);
    expect(JSON.stringify(log)).not.toContain(TOKEN_A);
  });

  it("with nothing connected it still succeeds and logs the event", async () => {
    installPlaidFake();
    const { dir } = await loadApp();
    const { DELETE } = await import("@/app/api/data/route");
    const res = await DELETE(req("/api/data", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, results: [] });
    expect(raw(dir, "SELECT 1 FROM security_log WHERE event = 'data_delete_all'")).toHaveLength(1);
  });

  it("when one revoke fails: 502 revoke_incomplete, per-item results, no wipe, failed item kept for retry", async () => {
    const plaid = installPlaidFake();
    plaid.itemRemove.mockImplementation(async (r) => {
      if (r?.access_token === TOKEN_B) {
        throw plaidError("INTERNAL_SERVER_ERROR", {
          status: 500,
          error_type: "API_ERROR",
          error_message: `boom for ${TOKEN_B}`,
          requestBody: JSON.stringify({ access_token: TOKEN_B }),
        });
      }
      return { data: { request_id: "req_ok" } };
    });
    const { db, dir } = await loadApp();
    await seedTwo(db);

    const { DELETE } = await import("@/app/api/data/route");
    const res = await DELETE(req("/api/data", { method: "DELETE" }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(TOKEN_A);
    expect(text).not.toContain(TOKEN_B);
    expect(text).not.toContain("error_message");
    const body = JSON.parse(text) as {
      error: { code: string };
      results: Array<{ item_id: string; ok: boolean; code?: string }>;
    };
    expect(body.error).toEqual({ code: "revoke_incomplete" });
    const byId = Object.fromEntries(body.results.map((r) => [r.item_id, r]));
    expect(byId["plaid-item-a"]).toEqual({ item_id: "plaid-item-a", ok: true });
    expect(byId["plaid-item-b"]).toEqual({ item_id: "plaid-item-b", ok: false, code: "INTERNAL_SERVER_ERROR" });

    // The wipe did not run: the failed item keeps its token, account, fields and transaction,
    // and settings are untouched. (Item A was revoked and removed, as a normal disconnect does.)
    expect(await db.getItemSecret("plaid-item-b")).toEqual({ access_token: TOKEN_B });
    expect((await db.getItemById("row-b"))?.status).toBe("revoke_failed");
    expect(count(dir, "accounts")).toBe(1);
    expect(count(dir, "account_fields")).toBeGreaterThan(0);
    expect(count(dir, "transactions")).toBe(1);
    expect(raw<{ key: string }>(dir, "SELECT key FROM settings ORDER BY key").map((r) => r.key)).toEqual([
      "plaid_client_user_id",
      "some_cache",
    ]);
    const log = raw<{ outcome: string }>(dir, "SELECT outcome FROM security_log WHERE event = 'data_delete_all'");
    expect(log).toEqual([{ outcome: "revoke_incomplete" }]);

    // Retry after the provider recovers completes the wipe.
    plaid.itemRemove.mockImplementation(async () => ({ data: { request_id: "req_ok" } }));
    const retry = await DELETE(req("/api/data", { method: "DELETE" }));
    expect(retry.status).toBe(200);
    expect(count(dir, "plaid_items")).toBe(0);
    expect(count(dir, "accounts")).toBe(0);
  });

  describe("under AUTH_MODE=required", () => {
    it("401 without a session; 403 without the custom header or with a foreign origin; nothing is touched", async () => {
      const plaid = installPlaidFake();
      const { db, dir } = await loadApp(REQUIRED_ENV);
      await seedTwo(db);
      const { createSession } = await import("@/lib/auth/session");
      const token = await createSession();
      const { DELETE } = await import("@/app/api/data/route");

      expect((await DELETE(makeReq("/api/data", { method: "DELETE" }))).status).toBe(401);

      const noHeader = await DELETE(makeReq("/api/data", { method: "DELETE", token, csrfHeader: false }));
      expect(noHeader.status).toBe(403);
      expect(await noHeader.json()).toEqual({ error: { code: "csrf" } });

      const badOrigin = await DELETE(
        makeReq("/api/data", { method: "DELETE", token, origin: "https://evil.example" })
      );
      expect(badOrigin.status).toBe(403);

      expect(plaid.itemRemove).not.toHaveBeenCalled();
      expect(count(dir, "plaid_items")).toBe(2);
    });

    it("with session + header it deletes and rotates the session cookie", async () => {
      installPlaidFake();
      const { db, dir } = await loadApp(REQUIRED_ENV);
      await seedTwo(db);
      const { createSession } = await import("@/lib/auth/session");
      const token = await createSession();
      const { DELETE } = await import("@/app/api/data/route");

      const res = await DELETE(makeReq("/api/data", { method: "DELETE", token }));
      expect(res.status).toBe(200);
      expect(count(dir, "plaid_items")).toBe(0);
      const cookies = res.headers.getSetCookie();
      expect(cookies.some((c) => c.startsWith(`${COOKIE_NAME}=`) && !c.startsWith(`${COOKIE_NAME}=${token}`))).toBe(
        true
      );
    });
  });
});
