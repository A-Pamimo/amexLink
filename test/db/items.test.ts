import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";

afterEach(() => closeApp());

const row = {
  id: "row-1",
  access_token: "access-sandbox-secret-123",
  item_id: "plaid-item-1",
  institution_name: "Amex Canada",
  institution_id: "ins_100533",
};

describe("items repo", () => {
  it("never returns the access token from item reads", async () => {
    const { db } = await loadApp();
    const inserted = await db.insertItem(row);
    expect("access_token" in inserted).toBe(false);

    const byId = await db.getItemById("row-1");
    expect(byId).not.toBeNull();
    expect("access_token" in byId!).toBe(false);
    expect(byId!.institution_name).toBe("Amex Canada");

    const byItemId = await db.getItemByItemId("plaid-item-1");
    expect("access_token" in byItemId!).toBe(false);

    const listed = await db.listItems();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("access-sandbox-secret-123");
  });

  it("getItemSecret returns the token, or null for unknown items", async () => {
    const { db } = await loadApp();
    await db.insertItem(row);
    expect(await db.getItemSecret("plaid-item-1")).toEqual({
      access_token: "access-sandbox-secret-123",
    });
    expect(await db.getItemSecret("nope")).toBeNull();
    expect(await db.getItemById("nope")).toBeNull();
  });

  it("settings and security_log round-trip", async () => {
    const { db } = await loadApp();
    expect(await db.getSetting("k")).toBeNull();
    await db.setSetting("k", "v1");
    await db.setSetting("k", "v2");
    expect(await db.getSetting("k")).toBe("v2");

    const { audit } = await import("@/lib/audit");
    await audit("test.event", { item_id: "plaid-item-1", outcome: "ok" });
  });
});
