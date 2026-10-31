import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";

afterEach(() => closeApp());

async function boot(env: Record<string, string>) {
  await loadApp(env);
  const { assertBootConfig } = await import("@/lib/boot");
  return assertBootConfig;
}

describe("assertBootConfig (WP2 auth refusals)", () => {
  it("refuses AUTH_MODE=none in production", async () => {
    const run = await boot({ NODE_ENV: "production", AUTH_MODE: "none", APP_ORIGIN: "https://cards.example" });
    expect(run).toThrow(/AUTH_MODE=none is refused in production/);
  });

  it("refuses AUTH_MODE=required without APP_ORIGIN", async () => {
    const run = await boot({ AUTH_MODE: "required" });
    expect(process.env.APP_ORIGIN ?? "").toBe("");
    expect(run).toThrow(/APP_ORIGIN/);
  });

  it("refuses an http:// APP_ORIGIN in production", async () => {
    const run = await boot({ NODE_ENV: "production", AUTH_MODE: "required", APP_ORIGIN: "http://cards.example" });
    expect(run).toThrow(/https:\/\//);
  });

  it("refuses COOKIE_INSECURE_DEV=1 in production", async () => {
    const run = await boot({
      NODE_ENV: "production",
      AUTH_MODE: "required",
      APP_ORIGIN: "https://cards.example",
      COOKIE_INSECURE_DEV: "1",
    });
    expect(run).toThrow(/COOKIE_INSECURE_DEV/);
  });

  it("accepts a production config with https origin, and dev with http", async () => {
    const prod = await boot({ NODE_ENV: "production", AUTH_MODE: "required", APP_ORIGIN: "https://cards.example" });
    expect(prod).not.toThrow();
    const dev = await boot({ AUTH_MODE: "required", APP_ORIGIN: "http://localhost:3000", COOKIE_INSECURE_DEV: "1" });
    expect(dev).not.toThrow();
    const none = await boot({ AUTH_MODE: "none" });
    expect(none).not.toThrow();
  });

  it("lib/env rejects removed modes, malformed origins and short setup tokens", async () => {
    await expect(loadApp({ AUTH_MODE: "password" })).rejects.toThrow(/AUTH_MODE must be one of none\|required/);
    await expect(loadApp({ AUTH_MODE: "passkey" })).rejects.toThrow(/AUTH_MODE must be one of/);
    await expect(loadApp({ APP_ORIGIN: "localhost:3000" })).rejects.toThrow(/APP_ORIGIN/);
    await expect(loadApp({ APP_ORIGIN: "http://localhost:3000/app" })).rejects.toThrow(/origin only/);
    await expect(loadApp({ AUTH_SETUP_TOKEN: "short" })).rejects.toThrow(/at least 32/);
    // trailing slash is normalised, not rejected
    await loadApp({ APP_ORIGIN: "http://localhost:3000/" });
    const { env } = await import("@/lib/env");
    expect(env.APP_ORIGIN).toBe("http://localhost:3000");
    expect(env.AUTH_MODE).toBe("none"); // test/setup.ts default
  });

  it("defaults AUTH_MODE to required when unset or empty", async () => {
    await loadApp({ AUTH_MODE: "" });
    const { env } = await import("@/lib/env");
    expect(env.AUTH_MODE).toBe("required");
    const { authMode } = await import("@/lib/auth/mode");
    expect(authMode()).toBe("required");
  });
});
