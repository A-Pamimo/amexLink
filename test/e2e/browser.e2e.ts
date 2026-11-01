import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api as apiOn,
  contextFor,
  COOKIE,
  expectJson,
  mintSession as mintOn,
  reserveTotpCode,
  takeRecoveryCode,
  type E2EContext,
  type ReqOptions,
} from "./helpers/client";
import { makeConfig, startServer, stopServer, type RunningServer } from "./helpers/server";

/**
 * Real Chromium against a server of its own on http://localhost:3134 (WebAuthn refuses an
 * IP-address RP ID, so the shared 127.0.0.1 server cannot host passkeys):
 *  - passkey enrolment and sign-in through the actual UI with a CDP virtual authenticator;
 *  - replay of a captured assertion and a signature-counter regression are both refused;
 *  - the post-login `from` redirect is sanitised in the browser;
 *  - no CSP violation is reported while the pages hydrate.
 */

interface AuthStatus {
  factors: { totp: boolean; passkeys: number; recovery_codes_remaining: number | null };
}

let ctx: E2EContext;
let server: RunningServer;
let dir: string;
const api = (p: string, opts?: ReqOptions) => apiOn(p, opts, ctx);
const mintSession = () => mintOn({}, ctx);
const e2e = () => ctx;

async function status(): Promise<AuthStatus> {
  return expectJson<AuthStatus>(await api("/api/auth/status"));
}

function passkeyCounter(): number | null {
  const db = new Database(ctx.dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT counter FROM passkeys").get() as { counter: number } | undefined;
    return row ? row.counter : null;
  } finally {
    db.close();
  }
}

interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
  largeBlob?: string;
  backupEligibility?: boolean;
  backupState?: boolean;
}

describe("browser: passkeys, redirect sanitiser, CSP", () => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  const cspViolations: string[] = [];
  const dialogs: string[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-e2e-browser-"));
    server = await startServer(makeConfig(3134, dir, "localhost"));
    ctx = await contextFor(server);
    browser = await chromium.launch();
  });
  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser?.close();
    if (server) await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function newPage(session?: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    contexts.push(context);
    if (session) {
      await context.addCookies([{ name: COOKIE, value: session, url: e2e().base, httpOnly: true, sameSite: "Lax" }]);
    }
    const page = await context.newPage();
    page.on("console", (m) => {
      if (/Content[- ]Security[- ]Policy|Refused to/i.test(m.text())) cspViolations.push(m.text());
    });
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    return { context, page };
  }

  async function virtualAuthenticator(context: BrowserContext, page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    return { cdp, authenticatorId };
  }

  it("enrol a passkey in Settings, sign out, sign in with it; replay and counter regression are refused", async () => {
    const { base } = e2e();
    expect((await status()).factors.passkeys).toBe(0);

    const session = await mintSession();
    const { context, page } = await newPage(session);
    const { cdp, authenticatorId } = await virtualAuthenticator(context, page);

    await page.goto(`${base}/settings`);
    await page.getByRole("button", { name: "Add passkey" }).click();
    await expect.poll(async () => (await status()).factors.passkeys, { timeout: 20_000 }).toBe(1);
    await page.getByText("Passkey added").waitFor({ timeout: 10_000 });
    // Chromium's virtual authenticator starts its signature counter at 1; real keys may say 0.
    const enrolled = passkeyCounter();
    expect(enrolled).not.toBeNull();
    expect(enrolled!).toBeGreaterThanOrEqual(0);

    // Sign out through the UI; the server row is gone so the old cookie is dead.
    await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
    await page.waitForURL(`${base}/login`, { timeout: 20_000 });
    expect((await api("/api/items", { session })).status).toBe(401);

    // Sign in with the passkey; capture the assertion the browser sends.
    let captured: string | null = null;
    await page.route("**/api/auth/login/passkey/verify", async (route) => {
      captured = route.request().postData();
      await route.continue();
    });
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL(`${base}/`, { timeout: 20_000 });
    await page.unroute("**/api/auth/login/passkey/verify");
    expect(captured).toBeTruthy();
    const afterLogin = passkeyCounter()!;
    expect(afterLogin).toBeGreaterThan(enrolled!);
    const cookies = await context.cookies(base);
    const live = cookies.find((c) => c.name === COOKIE);
    expect(live?.httpOnly).toBe(true);
    expect(live?.sameSite).toBe("Lax");
    expect((await api("/api/items", { session: live!.value })).status).toBe(200);

    // Replay the exact same assertion (challenge already consumed) -> 401, no cookie.
    const replay = await page.evaluate(async (body: string) => {
      const r = await fetch("/api/auth/login/passkey/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "X-AmexLens-Request": "1" },
        body,
      });
      return { status: r.status, body: await r.json() };
    }, captured!);
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: { code: "invalid_code" } });
    expect(passkeyCounter()).toBe(afterLogin);

    // Counter regression: a "cloned" authenticator with a stale signature counter.
    const { credentials } = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })) as { credentials: VirtualCredential[] };
    expect(credentials).toHaveLength(1);
    const cred = credentials[0];
    expect(cred.signCount).toBeGreaterThanOrEqual(1);
    await cdp.send("WebAuthn.removeCredential", { authenticatorId, credentialId: cred.credentialId });
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { ...cred, signCount: 0 } });

    await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
    await page.waitForURL(`${base}/login`, { timeout: 20_000 });
    let regressionStatus: number | null = null;
    page.on("response", (res) => {
      if (res.url().endsWith("/api/auth/login/passkey/verify")) regressionStatus = res.status();
    });
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.getByText("Passkey sign-in failed").waitFor({ timeout: 20_000 });
    expect(regressionStatus).toBe(401);
    expect(page.url()).toBe(`${base}/login`);
    expect(passkeyCounter()).toBe(afterLogin);
    expect((await context.cookies(base)).find((c) => c.name === COOKIE)).toBeUndefined();

    // A genuine authenticator state ahead of the server counter signs in again.
    await cdp.send("WebAuthn.removeCredential", { authenticatorId, credentialId: cred.credentialId });
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { ...cred, signCount: 50 } });
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL(`${base}/`, { timeout: 20_000 });
    expect(passkeyCounter()).toBe(51);
    expect(51).toBeGreaterThan(afterLogin);
  });

  it("post-login `from` is sanitised in the browser: //evil.example and javascript: land on /", async () => {
    const { base, stateFile } = e2e();

    const a = await newPage();
    await a.page.goto(`${base}/login?from=%2F%2Fevil.example`);
    const code = await reserveTotpCode(stateFile, { wait: true });
    await a.page.getByPlaceholder("123456").fill(code!);
    await a.page.getByRole("button", { name: "Sign in with code" }).click();
    await a.page.waitForURL(`${base}/`, { timeout: 20_000 });
    expect(a.page.url()).toBe(`${base}/`);

    const b = await newPage();
    await b.page.goto(`${base}/login?from=javascript:alert(1)`);
    await b.page.getByRole("button", { name: "Use a recovery code" }).click();
    await b.page.getByPlaceholder("xxxxx-xxxxx").fill(takeRecoveryCode(stateFile)!);
    await b.page.getByRole("button", { name: "Sign in with recovery code" }).click();
    await b.page.waitForURL(`${base}/`, { timeout: 20_000 });
    expect(b.page.url()).toBe(`${base}/`);

    const c = await newPage();
    await c.page.goto(`${base}/login?from=%2Ftransactions`);
    await c.page.getByRole("button", { name: "Use a recovery code" }).click();
    await c.page.getByPlaceholder("xxxxx-xxxxx").fill(takeRecoveryCode(stateFile)!);
    await c.page.getByRole("button", { name: "Sign in with recovery code" }).click();
    await c.page.waitForURL(`${base}/transactions`, { timeout: 20_000 });
    expect(c.page.url()).toBe(`${base}/transactions`);

    expect(dialogs).toEqual([]);
  });

  it("no CSP violation while /login, / and /settings hydrate", async () => {
    const { base } = e2e();
    const session = await mintSession();
    const { page } = await newPage(session);
    for (const p of ["/login", "/", "/settings", "/transactions", "/spending"]) {
      await page.goto(`${base}${p}`, { waitUntil: "networkidle" });
    }
    expect(cspViolations).toEqual([]);
  });
});
