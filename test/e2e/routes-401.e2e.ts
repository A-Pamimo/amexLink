import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { api, e2e, expectJson } from "./helpers/client";
import { ROOT } from "./helpers/server";

/**
 * Every /api route on disk (except the public health probe and the auth endpoints, which have
 * their own authenticators) answers 401 JSON over real HTTP without a session, with the legacy
 * `amexlens_auth=ok` cookie, with a random token-shaped cookie, and with every known
 * `x-middleware-subrequest` bypass value. Handler-level enforcement (middleware skipped
 * entirely) is proven by test/auth/routes-401.test.ts, which calls the handlers directly.
 */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(p));
    else if (entry.name === "route.ts") out.push(p);
  }
  return out;
}

interface Route {
  file: string;
  pathname: string;
  methods: Method[];
}

const routes: Route[] = routeFiles(path.join(ROOT, "app", "api"))
  .map((abs) => path.relative(ROOT, abs).split(path.sep).join("/"))
  .filter((rel) => !rel.startsWith("app/api/health/") && !rel.startsWith("app/api/auth/"))
  .sort()
  .map((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const methods = METHODS.filter((m) =>
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(src)
    );
    return {
      file: rel,
      pathname: "/" + rel.replace(/^app\//, "").replace(/\/route\.ts$/, "").replace("[id]", "e2e-x"),
      methods,
    };
  });

const COOKIES: Array<[string, string | undefined]> = [
  ["no cookie", undefined],
  ["legacy amexlens_auth=ok", "amexlens_auth=ok"],
  ["amexlens_session=ok", "amexlens_session=ok"],
  // 43 chars, token-shaped, unknown to the server: passes middleware, must die in the handler.
  ["random 43-char token", "amexlens_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ["__Host- name over plain http", "__Host-amexlens_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
];

const BYPASS_HEADERS = [
  "middleware",
  "middleware:middleware:middleware:middleware:middleware",
  "src/middleware",
  "src/middleware:src/middleware:src/middleware:src/middleware:src/middleware",
];

async function assert401(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toMatch(/application\/json/);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(await expectJson(res)).toEqual({ error: { code: "unauthenticated" } });
}

describe("every /api route requires a session over HTTP", () => {
  it("enumerated the route modules on disk", () => {
    expect(routes.length).toBeGreaterThanOrEqual(15);
    for (const r of routes) expect(r.methods.length, r.file).toBeGreaterThan(0);
    expect(routes.map((r) => r.pathname)).toEqual(
      expect.arrayContaining([
        "/api/items",
        "/api/items/e2e-x",
        "/api/cards",
        "/api/cards/e2e-x/refresh",
        "/api/data",
        "/api/plaid/exchange",
        "/api/plaid/link-token",
        "/api/plaid/sync",
        "/api/system",
        "/api/transactions",
      ])
    );
  });

  for (const route of routes) {
    describe(route.file, () => {
      for (const [label, cookie] of COOKIES) {
        it(`401 for ${route.methods.join("/")} (${label})`, async () => {
          for (const method of route.methods) {
            const res = await api(route.pathname, {
              method,
              cookie: cookie ?? null,
              json: method === "GET" ? undefined : {},
              headers: { "x-forwarded-for": "203.0.113.9" },
            });
            await assert401(res);
          }
        });
      }

      it("x-middleware-subrequest does not bypass", async () => {
        for (const value of BYPASS_HEADERS) {
          for (const method of route.methods) {
            const res = await api(route.pathname, {
              method,
              json: method === "GET" ? undefined : {},
              headers: { "x-middleware-subrequest": value },
            });
            await assert401(res);
          }
        }
      });
    });
  }

  it("POST /api/plaid/sync with a bogus bearer skips middleware and is still 401 in the handler", async () => {
    const res = await api("/api/plaid/sync", {
      method: "POST",
      headers: { authorization: "Bearer not-the-cron-secret-at-all-0123456789" },
    });
    await assert401(res);
  });

  it("HEAD and OPTIONS never leak a body or a 200 on a protected route", async () => {
    const head = await api("/api/items", { method: "HEAD" });
    expect(head.status).toBe(401);
    expect(await head.text()).toBe("");
    const opt = await api("/api/items", { method: "OPTIONS" });
    expect(opt.status).not.toBe(200);
  });

  it("the log does not contain the setup token, the cron secret or any session cookie", () => {
    const { logFile, setupToken, cronSecret } = e2e();
    const log = fs.readFileSync(logFile, "utf8");
    expect(log).not.toContain(setupToken);
    expect(log).not.toContain(cronSecret);
    expect(log).not.toMatch(/amexlens_session=/);
  });
});
