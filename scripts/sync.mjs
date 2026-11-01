#!/usr/bin/env node
// Headless sync: useful for cron. Hits the running app's /api/plaid/sync.
// Set BASE_URL=http://127.0.0.1:3000 (default) and AUTH_PASSWORD if AUTH_MODE=password.
// Logs counts and status codes only (SECURITY.md 3.6): never the response body.
import { log } from "./log.mjs";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";

async function login(password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return res.headers.get("set-cookie") ?? "";
}

function num(v) {
  return typeof v === "number" ? v : undefined;
}

async function main() {
  const headers = {};
  if (process.env.AUTH_PASSWORD) {
    headers["cookie"] = await login(process.env.AUTH_PASSWORD);
  }
  const res = await fetch(`${base}/api/plaid/sync`, { method: "POST", headers });
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (!res.ok) {
    log.error("sync_failed", {
      status: res.status,
      error_code: typeof body?.error_code === "string" ? body.error_code : undefined,
      request_id: typeof body?.request_id === "string" ? body.request_id : undefined,
    });
    process.exit(1);
  }
  log.info("sync_ok", {
    status: res.status,
    added: num(body?.added),
    modified: num(body?.modified),
    removed: num(body?.removed),
  });
}

main().catch((err) => {
  log.error("sync_failed", { error: err });
  process.exit(1);
});
