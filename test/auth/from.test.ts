import { describe, expect, it } from "vitest";
import { safeFrom } from "@/lib/auth/from";

describe("safeFrom", () => {
  it("allows only single-slash relative paths", () => {
    expect(safeFrom("/ok/path-1")).toBe("/ok/path-1");
    expect(safeFrom("/")).toBe("/");
    expect(safeFrom("/settings")).toBe("/settings");
    expect(safeFrom("/a_b/c-d/9")).toBe("/a_b/c-d/9");
  });

  it("rejects protocol-relative, backslash, absolute, scheme and junk values", () => {
    for (const bad of [
      "//evil.com",
      "///evil.com",
      "/x\\y",
      "https://e",
      "http://localhost:3000/",
      "javascript:alert(1)",
      "/transactions?x=1",
      "/a#b",
      "/%2F%2Fevil.com",
      "/path with space",
      "settings",
      "",
      null,
      undefined,
      "/ ",
    ]) {
      expect(safeFrom(bad as string | null | undefined), String(bad)).toBe("/");
    }
  });
});
