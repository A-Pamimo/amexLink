import fs from "node:fs";
import path from "node:path";
import { inject } from "vitest";
import { base32Decode, stepAt, TOTP_STEP_SECONDS, totpAt } from "@/lib/auth/totp";
import type { ServerConfig } from "./server";

/** Cookie name under COOKIE_INSECURE_DEV=1 (plain http, no __Host- prefix). */
export const COOKIE = "amexlens_session";
export const REQUEST_HEADER = "X-AmexLens-Request";

export interface E2EContext {
  base: string;
  origin: string;
  dbPath: string;
  logFile: string;
  setupToken: string;
  cronSecret: string;
  /** Path of the JSON file coordinating TOTP steps and recovery codes across test files. */
  stateFile: string;
}

export function e2e(): E2EContext {
  return inject("e2e");
}

// ---------------------------------------------------------------------------
// Raw HTTP
// ---------------------------------------------------------------------------

export interface ReqOptions {
  method?: string;
  /** Raw session token -> `Cookie: amexlens_session=<token>` */
  session?: string | null;
  /** Full Cookie header; wins over `session`. */
  cookie?: string | null;
  /** `undefined` -> the app origin; `null` -> no Origin header. */
  origin?: string | null;
  referer?: string;
  /** X-AmexLens-Request (default: present on non-GET). */
  csrf?: boolean;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
}

export function headersFor(origin: string, opts: ReqOptions = {}): Headers {
  const method = (opts.method ?? "GET").toUpperCase();
  const h = new Headers(opts.headers ?? {});
  if (opts.cookie) h.set("cookie", opts.cookie);
  else if (opts.session) h.set("cookie", `${COOKIE}=${opts.session}`);
  if (opts.origin !== null) h.set("origin", opts.origin ?? origin);
  if (opts.referer) h.set("referer", opts.referer);
  if (opts.csrf ?? method !== "GET") h.set(REQUEST_HEADER, "1");
  if (opts.json !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
  return h;
}

export async function api(pathname: string, opts: ReqOptions = {}, ctx: E2EContext = e2e()): Promise<Response> {
  const method = (opts.method ?? "GET").toUpperCase();
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.body;
  return fetch(ctx.base + pathname, {
    method,
    headers: headersFor(ctx.origin, { ...opts, method }),
    body,
    redirect: opts.redirect ?? "manual",
  });
}

/** Raw session token from Set-Cookie, or null (also null when the cookie is being cleared). */
export function cookieFrom(res: Response): string | null {
  for (const c of res.headers.getSetCookie()) {
    const m = new RegExp(`^${COOKIE}=([^;]*)`).exec(c);
    if (m) return m[1] === "" ? null : m[1];
  }
  return null;
}

export async function expectJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`not JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// TOTP seeding and session minting
// ---------------------------------------------------------------------------

interface State {
  secret: string; // base32
  lastStep: number;
  recovery: string[];
}

export function readState(file: string): State {
  return JSON.parse(fs.readFileSync(file, "utf8")) as State;
}

export function writeState(file: string, s: State): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
}

export function codeFor(secretB32: string, step: number): string {
  return totpAt(base32Decode(secretB32), step);
}

/** A six-digit code that is NOT valid for any step in the ±1 window right now. */
export function wrongCode(secretB32: string, now = Date.now()): string {
  const cur = stepAt(now);
  const valid = new Set([cur - 1, cur, cur + 1].map((s) => codeFor(secretB32, s)));
  for (let i = 0; i < 1000; i++) {
    const c = String(i).padStart(6, "0");
    if (!valid.has(c)) return c;
  }
  throw new Error("unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reserve a TOTP code the server has not seen yet. The server rejects any step <= the last
 * accepted one, so at most two logins fit in one 30-second window (current step and current+1);
 * when both are spent this waits for the next step.
 */
export async function reserveTotpCode(file: string, opts: { wait?: boolean } = {}): Promise<string | null> {
  const s = readState(file);
  const now = Date.now();
  const cur = stepAt(now);
  let step: number | null = null;
  if (cur > s.lastStep) step = cur;
  else if (cur + 1 > s.lastStep) step = cur + 1;
  if (step === null) {
    if (!opts.wait) return null;
    const nextStart = (s.lastStep + 1) * TOTP_STEP_SECONDS * 1000;
    await sleep(Math.max(0, nextStart - now) + 500);
    return reserveTotpCode(file, opts);
  }
  writeState(file, { ...s, lastStep: step });
  return codeFor(s.secret, step);
}

/** Take one recovery code out of the shared pool, or null when none is left. */
export function takeRecoveryCode(file: string): string | null {
  const s = readState(file);
  const code = s.recovery.shift() ?? null;
  writeState(file, s);
  return code;
}

export function setRecoveryCodes(file: string, codes: string[]): void {
  writeState(file, { ...readState(file), recovery: codes });
}

/**
 * Mint a valid session through the real login routes. Prefers a free TOTP step, then a
 * recovery code, then waits for the next TOTP step. Tops the recovery pool up when it runs dry.
 */
export async function mintSession(
  opts: { presenting?: string | null } = {},
  ctx: E2EContext = e2e()
): Promise<string> {
  const { stateFile } = ctx;
  let res: Response;
  const totp = await reserveTotpCode(stateFile);
  if (totp) {
    res = await api("/api/auth/login/totp", { method: "POST", json: { code: totp }, session: opts.presenting ?? null }, ctx);
  } else {
    const rc = takeRecoveryCode(stateFile);
    if (rc) {
      res = await api("/api/auth/login/recovery", { method: "POST", json: { code: rc }, session: opts.presenting ?? null }, ctx);
    } else {
      const code = await reserveTotpCode(stateFile, { wait: true });
      res = await api("/api/auth/login/totp", { method: "POST", json: { code }, session: opts.presenting ?? null }, ctx);
    }
  }
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const token = cookieFrom(res);
  if (!token) throw new Error("login did not set the session cookie");
  if (readState(stateFile).recovery.length === 0) {
    const fresh = await api("/api/auth/setup/recovery", { method: "POST", json: {}, session: token }, ctx);
    if (fresh.status !== 200) throw new Error(`recovery top-up failed: ${fresh.status}`);
    const body = await expectJson<{ recovery_codes: string[] }>(fresh);
    setRecoveryCodes(stateFile, body.recovery_codes);
  }
  return token;
}

/**
 * First-run enrolment through the real setup routes (what the owner does on /login once):
 * start TOTP with the setup token, confirm it with a live code. Returns the secret, the
 * step that was consumed, the recovery codes and the session the server issued.
 */
export async function seedTotp(cfg: ServerConfig): Promise<{
  secret: string;
  lastStep: number;
  recovery: string[];
  session: string;
}> {
  const post = (p: string, json: unknown) =>
    fetch(cfg.origin + p, {
      method: "POST",
      headers: headersFor(cfg.origin, { method: "POST", json }),
      body: JSON.stringify(json),
    });
  const start = await post("/api/auth/setup/totp/start", { setup_token: cfg.setupToken });
  if (start.status !== 200) throw new Error(`totp/start ${start.status}: ${await start.text()}`);
  const { otpauth_uri } = (await start.json()) as { otpauth_uri: string };
  const secret = new URL(otpauth_uri).searchParams.get("secret");
  if (!secret) throw new Error("otpauth uri without secret");
  const step = stepAt(Date.now());
  const confirm = await post("/api/auth/setup/totp/confirm", {
    setup_token: cfg.setupToken,
    code: codeFor(secret, step),
  });
  if (confirm.status !== 200) throw new Error(`totp/confirm ${confirm.status}: ${await confirm.text()}`);
  const body = (await confirm.json()) as { recovery_codes: string[] };
  const session = cookieFrom(confirm);
  if (!session) throw new Error("confirm did not set a session cookie");
  return { secret, lastStep: step, recovery: body.recovery_codes, session };
}

export function stateFileFor(dir: string): string {
  return path.join(dir, "e2e-state.json");
}

/** Context for a test file that runs its own server (seeds TOTP and writes the state file). */
export async function contextFor(cfg: ServerConfig): Promise<E2EContext> {
  const seeded = await seedTotp(cfg);
  const stateFile = stateFileFor(cfg.dir);
  writeState(stateFile, { secret: seeded.secret, lastStep: seeded.lastStep, recovery: seeded.recovery });
  return {
    base: cfg.origin,
    origin: cfg.origin,
    dbPath: cfg.dbPath,
    logFile: cfg.logFile,
    setupToken: cfg.setupToken,
    cronSecret: cfg.cronSecret,
    stateFile,
  };
}
