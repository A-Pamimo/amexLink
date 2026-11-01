import { describe, expect, it } from "vitest";
import { api, cookieFrom, expectJson, mintSession } from "./helpers/client";

describe("delete all local data and the privacy notice", () => {
  it("DELETE /api/data needs a session and CSRF, succeeds with no items and rotates the session", async () => {
    expect((await api("/api/data", { method: "DELETE" })).status).toBe(401);
    const session = await mintSession();
    expect((await api("/api/data", { method: "DELETE", session, csrf: false })).status).toBe(403);
    expect((await api("/api/data", { method: "DELETE", session, origin: "https://evil.example" })).status).toBe(403);

    const res = await api("/api/data", { method: "DELETE", session });
    expect(res.status).toBe(200);
    expect(await expectJson(res)).toEqual({ ok: true, results: [] });
    const rotated = cookieFrom(res);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(session);
    expect((await api("/api/items", { session })).status).toBe(401);
    expect((await api("/api/items", { session: rotated })).status).toBe(200);

    // Factors survive the wipe: a new login still works.
    const again = await mintSession();
    expect((await api("/api/auth/status", { session: again })).status).toBe(200);
  });

  it("the settings page names the processor and the storage country", async () => {
    const session = await mintSession();
    const res = await api("/settings", { session });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("processes the data in the United States");
    expect(html).toContain("Plaid Inc.");
    expect(html).toContain("Delete all local data");
    expect(html).not.toMatch(/access-(sandbox|development|production)-/);
  });
});
