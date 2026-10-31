import { afterEach, describe, expect, it, vi } from "vitest";
import { log, redact } from "@/lib/log";

const TOKEN = "access-sandbox-abc123";
const SECRET = "plaid-secret-value-9f8e7d";

/** Shape of an axios error as thrown by the Plaid SDK. */
function fakePlaidError() {
  const err = new Error("Request failed with status code 400") as Error & Record<string, unknown>;
  err.isAxiosError = true;
  err.config = {
    url: "https://sandbox.plaid.com/transactions/sync",
    headers: { "PLAID-SECRET": SECRET, "Content-Type": "application/json" },
    data: JSON.stringify({ access_token: TOKEN, cursor: "c1" }),
  };
  err.response = {
    status: 400,
    headers: { "Set-Cookie": "session=abc; HttpOnly", "plaid-request-id": "req-1" },
    data: {
      error_code: "ITEM_LOGIN_REQUIRED",
      error_type: "ITEM_ERROR",
      error_message: `the user must re-authenticate; token ${TOKEN}`,
      request_id: "req-1",
    },
  };
  return err;
}

describe("redact", () => {
  it("strips tokens, secrets and cookies from a nested Plaid/axios error", () => {
    const input = {
      context: {
        PLAID_SECRET: SECRET,
        plaidError: fakePlaidError(),
        headers: { "Set-Cookie": "a=b", cookie: "c=d", Authorization: "Bearer zzz" },
        nested: { deeper: { access_token: TOKEN, note: `saw ${TOKEN} in body` } },
      },
    };
    const out = JSON.stringify(redact(input));
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("a=b");
    expect(out).not.toContain("c=d");
    expect(out).not.toContain("Bearer zzz");
    expect(out).toContain("ITEM_LOGIN_REQUIRED");
    expect(out).toContain("ITEM_ERROR");
    expect(out).toContain("req-1");
    expect(out).toContain("[redacted]");
  });

  it("reduces a provider error object to the safe identifier fields", () => {
    const out = redact(fakePlaidError()) as Record<string, unknown>;
    expect(out).toEqual({
      error_code: "ITEM_LOGIN_REQUIRED",
      error_type: "ITEM_ERROR",
      request_id: "req-1",
      status: 400,
    });
  });

  it("recognises Plaid errors by response.data.error_code without isAxiosError", () => {
    const out = redact({ response: { status: 429, data: { error_code: "RATE_LIMIT" } } });
    expect(out).toEqual({ error_code: "RATE_LIMIT", error_type: undefined, request_id: undefined, status: 429 });
  });

  it("redacts link/public/production token shapes inside strings and arrays", () => {
    const out = JSON.stringify(
      redact(["public-sandbox-1-2", { x: "link-production-abc" }, "access-development-zz9", "fine"])
    );
    expect(out).not.toMatch(/(public|link|access)-(sandbox|production|development)-/);
    expect(out).toContain("fine");
  });

  it("reduces Error instances and caps depth", () => {
    const e = redact(new TypeError(`bad ${TOKEN}`)) as { name: string; message: string };
    expect(e.name).toBe("TypeError");
    expect(e.message).not.toContain(TOKEN);

    let deep: Record<string, unknown> = { leaf: TOKEN };
    for (let i = 0; i < 10; i++) deep = { level: deep };
    const out = JSON.stringify(redact(deep));
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("[depth]");
  });
});

describe("log", () => {
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  afterEach(() => {
    outSpy.mockClear();
    errSpy.mockClear();
  });

  it("writes one redacted JSON line per event; info to stdout, warn/error to stderr", () => {
    log.info("sync_finished", { added: 3, access_token: TOKEN });
    log.error("plaid_error", { err: fakePlaidError() });
    expect(outSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const infoLine = JSON.parse(String(outSpy.mock.calls[0][0]));
    expect(infoLine).toMatchObject({ level: "info", event: "sync_finished", added: 3, access_token: "[redacted]" });
    expect(typeof infoLine.t).toBe("string");
    const errLine = String(errSpy.mock.calls[0][0]);
    expect(errLine).not.toContain(TOKEN);
    expect(errLine).not.toContain(SECRET);
    expect(errLine).toContain("ITEM_LOGIN_REQUIRED");
  });
});
