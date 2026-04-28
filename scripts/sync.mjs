#!/usr/bin/env node
// Headless sync: useful for cron. Hits the running app's /api/plaid/sync.
// Set BASE_URL=http://localhost:3000 (default) and AUTH_PASSWORD if AUTH_MODE=password.

const base = process.env.BASE_URL ?? "http://localhost:3000";

async function login(password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return res.headers.get("set-cookie") ?? "";
}

async function main() {
  const headers = {};
  if (process.env.AUTH_PASSWORD) {
    headers["cookie"] = await login(process.env.AUTH_PASSWORD);
  }
  const res = await fetch(`${base}/api/plaid/sync`, { method: "POST", headers });
  const body = await res.json();
  if (!res.ok) {
    console.error("sync failed:", body);
    process.exit(1);
  }
  console.log("sync ok:", body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
