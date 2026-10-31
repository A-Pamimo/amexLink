import { beforeAll, describe, expect, it } from "vitest";
import { api, e2e, expectJson, mintSession } from "./helpers/client";

/** POST /api/plaid/sync: cron bearer vs browser session (SECURITY.md C-E3, P-S3). No items exist, so no Plaid call. */
describe("cron authorization on /api/plaid/sync", () => {
  let session: string;
  beforeAll(async () => {
    session = await mintSession();
  });

  it("wrong bearer -> 401 even with a valid session cookie and CSRF headers", async () => {
    for (const auth of [
      "Bearer definitely-not-the-secret-0123456789abcdef",
      "Bearer",
      "Basic " + Buffer.from("x:y").toString("base64"),
      `bearer ${e2e().cronSecret}x`,
      "",
    ]) {
      const res = await api("/api/plaid/sync", { method: "POST", session, headers: { authorization: auth } });
      expect(res.status, JSON.stringify(auth)).toBe(401);
      expect(await expectJson(res)).toEqual({ error: { code: "unauthenticated" } });
    }
  });

  it("bearer in the query string is ignored -> 401", async () => {
    const s = encodeURIComponent(e2e().cronSecret);
    for (const q of [`token=${s}`, `authorization=Bearer%20${s}`, `access_token=${s}`, `cron_secret=${s}`]) {
      const res = await api(`/api/plaid/sync?${q}`, { method: "POST" });
      expect(res.status, q).toBe(401);
    }
  });

  it("correct bearer -> 200 with counts only (no cookie, no CSRF headers needed)", async () => {
    const res = await api("/api/plaid/sync", {
      method: "POST",
      origin: null,
      csrf: false,
      headers: { authorization: `Bearer ${e2e().cronSecret}` },
    });
    expect(res.status).toBe(200);
    const body = await expectJson<{ items: unknown[]; totals: Record<string, number> }>(res);
    expect(body.items).toEqual([]);
    expect(body.totals).toEqual({ added: 0, modified: 0, removed: 0 });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("browser session path still needs CSRF; with it the sync runs", async () => {
    expect((await api("/api/plaid/sync", { method: "POST", session, csrf: false })).status).toBe(403);
    expect((await api("/api/plaid/sync", { method: "POST", session, origin: "https://evil.example" })).status).toBe(403);
    const ok = await api("/api/plaid/sync", { method: "POST", session });
    expect(ok.status).toBe(200);
  });

  it("GET on the sync route is not a thing", async () => {
    const res = await api("/api/plaid/sync", { headers: { authorization: `Bearer ${e2e().cronSecret}` } });
    expect([401, 405]).toContain(res.status);
  });
});
