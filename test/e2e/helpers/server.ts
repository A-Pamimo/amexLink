import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Builds and runs the production server for the attacker suite. No Plaid keys exist in CI, so
 * PLAID_CLIENT_ID / PLAID_SECRET are the literal `x`; every test avoids routes that would call
 * Plaid (or hits them only on paths that fail validation before the provider call).
 */

export const ROOT = path.resolve(__dirname, "..", "..", "..");
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

export interface ServerConfig {
  port: number;
  /** Temp directory holding the SQLite file and the server log. */
  dir: string;
  origin: string;
  dbPath: string;
  setupToken: string;
  cronSecret: string;
  dataKey: string;
  logFile: string;
}

export interface RunningServer extends ServerConfig {
  pid: number;
  child: ChildProcess;
}

/**
 * `host` is the hostname in APP_ORIGIN (the server always binds 127.0.0.1). The browser suite
 * uses `localhost`: WebAuthn refuses an IP-address RP ID, so passkeys never work on
 * http://127.0.0.1 (nor on a bare LAN IP; see docs/RED-TEAM.md).
 */
export function makeConfig(port: number, dir: string, host = "127.0.0.1"): ServerConfig {
  return {
    port,
    dir,
    origin: `http://${host}:${port}`,
    dbPath: path.join(dir, `e2e-${port}.sqlite`),
    setupToken: `e2e-setup-${randomBytes(24).toString("base64url")}`,
    cronSecret: `e2e-cron-${randomBytes(24).toString("base64url")}`,
    dataKey: randomBytes(32).toString("base64"),
    logFile: path.join(dir, `server-${port}.log`),
  };
}

/** Exactly the environment the brief prescribes; nothing from the developer's shell leaks in. */
export function serverEnv(cfg: ServerConfig): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: "production",
    AUTH_MODE: "required",
    APP_ORIGIN: cfg.origin,
    AUTH_SETUP_TOKEN: cfg.setupToken,
    CRON_SECRET: cfg.cronSecret,
    TOKEN_ENCRYPTION_KEY: cfg.dataKey,
    PLAID_CLIENT_ID: "x",
    PLAID_SECRET: "x",
    PLAID_ENV: "sandbox",
    COOKIE_INSECURE_DEV: "1",
    DB_PATH: cfg.dbPath,
  };
}

/** `next build` once per run. Set E2E_SKIP_BUILD=1 to reuse an existing .next (local iteration). */
export function buildOnce(): void {
  if (process.env.E2E_SKIP_BUILD === "1") return;
  const r = spawnSync(process.execPath, [NEXT_BIN, "build"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: "production",
      PLAID_CLIENT_ID: "x",
      PLAID_SECRET: "x",
      PLAID_ENV: "sandbox",
    },
  });
  if (r.status !== 0) throw new Error(`next build failed with status ${r.status}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function logTail(cfg: ServerConfig, lines = 40): string {
  try {
    return fs.readFileSync(cfg.logFile, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

export async function startServer(cfg: ServerConfig): Promise<RunningServer> {
  fs.mkdirSync(cfg.dir, { recursive: true });
  const fd = fs.openSync(cfg.logFile, "a");
  const child = spawn(
    process.execPath,
    [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(cfg.port)],
    { cwd: ROOT, env: serverEnv(cfg), detached: true, stdio: ["ignore", fd, fd] }
  );
  fs.closeSync(fd);
  if (!child.pid) throw new Error("next start did not spawn");
  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? -1;
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`next start exited early (${exited}):\n${logTail(cfg)}`);
    }
    try {
      const res = await fetch(`${cfg.origin}/api/health`);
      if (res.status === 200 && (await res.text()) === '{"ok":true}') {
        return { ...cfg, pid: child.pid, child };
      }
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  await stopServer({ ...cfg, pid: child.pid, child });
  throw new Error(`next start did not become healthy:\n${logTail(cfg)}`);
}

/** Kill by PID (the whole process group), SIGTERM then SIGKILL. */
export async function stopServer(s: RunningServer): Promise<void> {
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-s.pid, sig);
    } catch {
      try {
        process.kill(s.pid, sig);
      } catch {
        // already gone
      }
    }
  };
  if (s.child.exitCode !== null || s.child.signalCode !== null) return;
  const gone = new Promise<void>((resolve) => s.child.once("exit", () => resolve()));
  kill("SIGTERM");
  const timer = sleep(5_000).then(() => "timeout" as const);
  if ((await Promise.race([gone, timer])) === "timeout") {
    kill("SIGKILL");
    await Promise.race([gone, sleep(2_000)]);
  }
}
