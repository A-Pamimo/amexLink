import { describe, expect, it } from "vitest";
import {
  LINK_MAX_AGE_MS,
  LINK_STORAGE_KEY,
  clearLinkSession,
  isLinkAffectedKey,
  loadLinkSession,
  saveLinkSession,
} from "@/lib/client/plaid-link";

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("sessionStorage['amexlens_plaid_link'] contract", () => {
  it("stores exactly { token, mode, item_id, created_at }", () => {
    const storage = fakeStorage();
    saveLinkSession({ token: "link-sandbox-t", mode: "consent", item_id: "item_1" }, { now: 1000, storage });
    expect(LINK_STORAGE_KEY).toBe("amexlens_plaid_link");
    expect(JSON.parse(storage.m.get("amexlens_plaid_link")!)).toEqual({
      token: "link-sandbox-t",
      mode: "consent",
      item_id: "item_1",
      created_at: 1000,
    });
  });

  it("loads a fresh record and clears it on request", () => {
    const storage = fakeStorage();
    saveLinkSession({ token: "link-sandbox-t", mode: "new", item_id: null }, { now: 5_000, storage });
    expect(loadLinkSession({ now: 5_000 + 60_000, storage })).toEqual({
      token: "link-sandbox-t",
      mode: "new",
      item_id: null,
      created_at: 5_000,
    });
    clearLinkSession(storage);
    expect(loadLinkSession({ storage })).toBeNull();
  });

  it("a record older than 30 minutes is treated as missing and removed", () => {
    const storage = fakeStorage();
    saveLinkSession({ token: "link-sandbox-t", mode: "new", item_id: null }, { now: 0, storage });
    expect(loadLinkSession({ now: LINK_MAX_AGE_MS, storage })).not.toBeNull();
    expect(loadLinkSession({ now: LINK_MAX_AGE_MS + 1, storage })).toBeNull();
    expect(storage.m.size).toBe(0);
  });

  it.each([
    "not json",
    "null",
    JSON.stringify({ token: "", mode: "new", item_id: null, created_at: 1 }),
    JSON.stringify({ token: "t", mode: "delete", item_id: null, created_at: 1 }),
    JSON.stringify({ token: "t", mode: "new", item_id: 5, created_at: 1 }),
    JSON.stringify({ token: "t", mode: "new", item_id: null, created_at: "1" }),
    JSON.stringify({ token: "t", mode: "new", item_id: null, created_at: 10_000_000 }), // from the future
  ])("malformed or implausible record %s is rejected and removed", (raw) => {
    const storage = fakeStorage();
    storage.setItem(LINK_STORAGE_KEY, raw);
    expect(loadLinkSession({ now: 1000, storage })).toBeNull();
    expect(storage.m.size).toBe(0);
  });

  it("works without storage (SSR / blocked)", () => {
    expect(loadLinkSession({ storage: null })).toBeNull();
    expect(() => saveLinkSession({ token: "t", mode: "new", item_id: null }, { storage: null })).not.toThrow();
  });

  it("revalidation covers items, cards and stats", () => {
    for (const k of ["/api/items", "/api/cards", "/api/stats/totals?from=a", "/api/transactions?x=1"]) {
      expect(isLinkAffectedKey(k)).toBe(true);
    }
    expect(isLinkAffectedKey("/api/auth/factors")).toBe(false);
    expect(isLinkAffectedKey(["/api/items"])).toBe(false);
  });
});
