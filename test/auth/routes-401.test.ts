import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { REQUIRED_ENV } from "../helpers/auth";

/**
 * SECURITY.md §5 "Tests the PR must include": every route under app/api/**
 * (except the public health probe and the auth endpoints, which have their own
 * authenticators) answers 401 JSON without a session, with the legacy
 * `amexlens_auth=ok` cookie, and with a non-token value in the real cookie.
 * Routes added by later work packages are picked up automatically.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const API_DIR = path.join(ROOT, "app", "api");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(p));
    else if (entry.name === "route.ts") out.push(p);
  }
  return out;
}

const routes = routeFiles(API_DIR)
  .map((abs) => path.relative(ROOT, abs).split(path.sep).join("/"))
  .filter((rel) => !rel.startsWith("app/api/health/") && !rel.startsWith("app/api/auth/"))
  .sort();

const COOKIES: Array<[string, string | undefined]> = [
  ["no cookie", undefined],
  ["legacy amexlens_auth=ok", "amexlens_auth=ok"],
  ["__Host-amexlens_session=ok", "__Host-amexlens_session=ok"],
];

describe("every /api route requires a session (AUTH_MODE=required)", () => {
  beforeAll(async () => {
    await loadApp(REQUIRED_ENV);
  });
  afterAll(() => closeApp());

  it("found the expected route modules", () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        "app/api/items/route.ts",
        "app/api/items/[id]/route.ts",
        "app/api/plaid/exchange/route.ts",
        "app/api/plaid/link-token/route.ts",
        "app/api/plaid/sync/route.ts",
        "app/api/stats/totals/route.ts",
        "app/api/stats/trend/route.ts",
        "app/api/transactions/route.ts",
        "app/api/transactions/[id]/route.ts",
      ])
    );
  });

  for (const rel of routes) {
    describe(rel, () => {
      for (const [label, cookie] of COOKIES) {
        it(`401 JSON for every exported method (${label})`, async () => {
          const mod = (await import(path.join(ROOT, rel))) as Record<string, unknown>;
          const exported = METHODS.filter((m) => typeof mod[m] === "function");
          expect(exported.length).toBeGreaterThan(0);
          for (const method of exported) {
            const handler = mod[method] as (
              req: Request,
              ctx: { params: Promise<{ id: string }> }
            ) => Promise<Response>;
            const headers = new Headers({
              origin: "http://localhost:3000",
              "x-amexlens-request": "1",
              "x-forwarded-for": "203.0.113.9",
            });
            if (cookie) headers.set("cookie", cookie);
            const urlPath = "/" + rel.replace(/^app/, "").replace(/\/route\.ts$/, "").replace("[id]", "x");
            const res = await handler(
              new Request(`http://localhost:3000${urlPath}`, {
                method,
                headers,
                body: method === "GET" ? undefined : "{}",
              }),
              { params: Promise.resolve({ id: "x" }) }
            );
            expect(res.status, `${method} ${rel}`).toBe(401);
            expect(res.headers.get("location")).toBeNull();
            expect(res.headers.get("content-type")).toMatch(/application\/json/);
            expect(res.headers.get("cache-control")).toBe("no-store");
            expect(await res.json()).toEqual({ error: { code: "unauthenticated" } });
          }
        });
      }
    });
  }
});
