import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";

afterEach(() => closeApp());

async function envWith(PLAID_REDIRECT_URI: string) {
  await loadApp({ PLAID_REDIRECT_URI });
  return (await import("@/lib/env")).env;
}

describe("PLAID_REDIRECT_URI (lib/env.ts, validated at load)", () => {
  it("is null when unset or blank", async () => {
    expect((await envWith("")).PLAID_REDIRECT_URI).toBeNull();
    expect((await envWith("   ")).PLAID_REDIRECT_URI).toBeNull();
  });

  it("accepts an absolute http(s) URL with a path and returns it verbatim", async () => {
    expect((await envWith("http://localhost:3000/plaid/oauth")).PLAID_REDIRECT_URI).toBe("http://localhost:3000/plaid/oauth");
    expect((await envWith("https://cards.example/plaid/oauth")).PLAID_REDIRECT_URI).toBe("https://cards.example/plaid/oauth");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://x/plaid/oauth",
    "http://x/path?q=1",
    "http://x/path?",
    "http://x/path#frag",
    "http://x/path#",
    "/plaid/oauth",
    "localhost:3000/plaid/oauth",
    "not a url",
  ])("rejects %s at load", async (bad) => {
    await expect(loadApp({ PLAID_REDIRECT_URI: bad })).rejects.toThrow(/PLAID_REDIRECT_URI/);
  });

  it("production refuses a plain-http redirect URI at boot", async () => {
    await loadApp({
      PLAID_ENV: "production",
      AUTH_MODE: "required",
      APP_ORIGIN: "https://cards.example",
      PLAID_REDIRECT_URI: "http://cards.example/plaid/oauth",
    });
    const { assertBootConfig } = await import("@/lib/boot");
    expect(() => assertBootConfig()).toThrow(/PLAID_REDIRECT_URI must be https/);

    await loadApp({
      PLAID_ENV: "production",
      AUTH_MODE: "required",
      APP_ORIGIN: "https://cards.example",
      PLAID_REDIRECT_URI: "https://cards.example/plaid/oauth",
    });
    const boot = await import("@/lib/boot");
    expect(() => boot.assertBootConfig()).not.toThrow();
  });
});
