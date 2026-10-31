import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";

afterEach(() => closeApp());

describe("GET /api/items", () => {
  it("returns 200 and never includes access_token or cursor", async () => {
    const { db } = await loadApp();
    await db.insertItem({
      id: "row-1",
      access_token: "access-sandbox-secret-123",
      item_id: "plaid-item-1",
      institution_name: "Amex Canada",
      institution_id: "ins_100533",
    });
    await db.updateItemSync("plaid-item-1", "cursor-abc", "2026-10-31T00:00:00.000Z");

    const { GET } = await import("@/app/api/items/route");
    const res = await GET(new Request("http://localhost/api/items"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("access_token");
    expect(text).not.toContain("access-sandbox-secret-123");
    expect(text).not.toContain("cursor");

    const body = JSON.parse(text) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].status).toBe("active");
    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        "created_at",
        "id",
        "institution_id",
        "institution_name",
        "item_id",
        "last_error",
        "last_synced_at",
        "liabilities_status",
        "status",
      ].sort()
    );
  });
});
