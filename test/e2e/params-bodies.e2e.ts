import { beforeAll, describe, expect, it } from "vitest";
import { api, e2e, expectJson, headersFor, mintSession, type ReqOptions } from "./helpers/client";

const MiB = 1024 * 1024;

async function healthy(): Promise<void> {
  const res = await api("/api/health");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('{"ok":true}');
}

describe("hostile query parameters", () => {
  let session: string;
  beforeAll(async () => {
    session = await mintSession();
  });

  it("GET /api/transactions tolerates junk limit/offset/q and stays 200 and bounded", async () => {
    const queries = [
      "limit=1e9",
      "limit=-1",
      "limit=abc",
      "limit=99999999999999999999999",
      "limit=1&offset=-5",
      "offset=99999999999999",
      "q=%25",
      "q=_",
      "q=%5C",
      "q=" + encodeURIComponent("' OR 1=1 --"),
      "q=" + "a".repeat(5000),
      "bucket=" + encodeURIComponent("'; DROP TABLE transactions; --"),
      "item_id=" + "x".repeat(5000),
      "from=" + encodeURIComponent("9999-99-99") + "&to=" + encodeURIComponent("0000-00-00"),
    ];
    for (const q of queries) {
      const res = await api(`/api/transactions?${q}`, { session });
      expect(res.status, q).toBe(200);
      const body = await expectJson<{ transactions: unknown[] }>(res);
      expect(Array.isArray(body.transactions), q).toBe(true);
      expect(body.transactions.length).toBeLessThanOrEqual(1000);
    }
  });

  it("stats routes never 500 on junk", async () => {
    const cases = [
      "/api/stats/trend?months=abc",
      "/api/stats/trend?months=-1",
      "/api/stats/trend?months=999999",
      "/api/stats/trend?currency=" + encodeURIComponent("../etc"),
      "/api/stats/totals?from=x&to=y",
      "/api/stats/totals?currency=" + encodeURIComponent("C%20AD"),
      "/api/stats/currencies",
    ];
    for (const p of cases) {
      const res = await api(p, { session });
      expect([200, 400], p).toContain(res.status);
    }
    await healthy();
  });

  it("card refresh with a hostile id is 404, never a provider call or a 500", async () => {
    for (const id of ["..", "%2e%2e", "x'--", "a".repeat(65), "e2e-x"]) {
      const res = await api(`/api/cards/${id}/refresh`, { method: "POST", session, json: {} });
      expect([404], id).toContain(res.status);
    }
  });
});

describe("oversized and malformed bodies", () => {
  let session: string;
  beforeAll(async () => {
    session = await mintSession();
  });

  it("1 MiB JSON to /api/auth/login/totp -> 413, no lockout hit, process alive", async () => {
    const big = JSON.stringify({ code: "9".repeat(MiB) });
    const res = await api("/api/auth/login/totp", { method: "POST", body: big, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(413);
    expect(await expectJson(res)).toEqual({ error: { code: "payload_too_large" } });
    await healthy();
  });

  it("1 MiB JSON to /api/plaid/exchange (session) -> 413, never 500", async () => {
    const big = JSON.stringify({ public_token: "x".repeat(MiB) });
    const res = await api("/api/plaid/exchange", { method: "POST", session, body: big, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(413);
    await healthy();
  });

  it("a chunked body without Content-Length is cut off at the cap (streaming check)", async () => {
    const { base, origin } = e2e();
    const chunk = new TextEncoder().encode("{\"public_token\":\"" + "y".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4 * MiB) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const res = await fetch(`${base}/api/plaid/exchange`, {
      method: "POST",
      headers: headersFor(origin, { method: "POST", session, json: {} }),
      body: stream,
      // @ts-expect-error undici needs duplex for streaming request bodies
      duplex: "half",
    }).catch((err: unknown) => err);
    // Either the server answered 413 or it closed the connection early; both are a cut-off.
    if (res instanceof Response) expect(res.status).toBe(413);
    else expect(res).toBeInstanceOf(Error);
    await healthy();
  });

  it("invalid JSON, wrong content-type, arrays and nulls are 400/401, never 500", async () => {
    // Login routes count a malformed body as a failed attempt (that is the lockout working), so
    // only two such probes run here and a successful login resets the counter afterwards.
    const loginCases: Array<[string, ReqOptions]> = [
      ["/api/auth/login/totp", { body: "{not json", headers: { "content-type": "application/json" } }],
      ["/api/auth/login/passkey/verify", { json: { challenge_id: 1, response: "x" } }],
    ];
    for (const [p, opts] of loginCases) {
      const res = await api(p, { method: "POST", ...opts });
      expect(res.status, p).toBe(401);
      expect(await expectJson(res)).toEqual({ error: { code: "invalid_code" } });
    }
    await mintSession(); // success resets the login lockout bucket

    const cases: Array<[string, ReqOptions, number[]]> = [
      ["/api/plaid/exchange", { session, body: "{not json", headers: { "content-type": "application/json" } }, [400]],
      ["/api/plaid/exchange", { session, body: "[]", headers: { "content-type": "application/json" } }, [400]],
      ["/api/plaid/exchange", { session, body: "null", headers: { "content-type": "application/json" } }, [400]],
      ["/api/plaid/exchange", { session, body: "public_token=x", headers: { "content-type": "text/plain" } }, [400]],
      ["/api/plaid/exchange", { session, json: { public_token: 12 } }, [400]],
      ["/api/plaid/link-token", { session, body: "[1]", headers: { "content-type": "application/json" } }, [400]],
      ["/api/plaid/link-token", { session, json: { mode: "repair" } }, [400]],
      ["/api/plaid/link-token", { session, json: { mode: "nope" } }, [400]],
      ["/api/plaid/consent", { session, json: { item_id: "x".repeat(200) } }, [400]],
      ["/api/plaid/repair", { session, json: {} }, [400]],
      ["/api/transactions/e2e-x", { method: "PATCH", session, json: { bucket: "__proto__" } }, [400]],
    ];
    for (const [p, opts, allowed] of cases) {
      const res = await api(p, { method: opts.method ?? "POST", ...opts });
      expect(allowed, `${p} ${JSON.stringify(opts.json ?? opts.body)}`).toContain(res.status);
    }
    await healthy();
  });
});
