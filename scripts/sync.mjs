#!/usr/bin/env node
// Headless sync for cron. POSTs to the running app's /api/plaid/sync with
//   Authorization: Bearer $CRON_SECRET
// The secret is a dedicated high-entropy value (>= 32 chars), NOT the interactive login.
//
//   CRON_SECRET=...            required; the script refuses to run without it
//   BASE_URL=http://127.0.0.1:3000   default; must be loopback unless --allow-remote
//
// Output is counts and short codes only; response bodies are never echoed.

const allowRemote = process.argv.includes("--allow-remote");
const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const secret = process.env.CRON_SECRET ?? "";

function fail(msg) {
  console.error(`sync: ${msg}`);
  process.exit(1);
}

if (secret.length < 32) {
  fail("CRON_SECRET is not set (or shorter than 32 characters); refusing to run");
}

let url;
try {
  url = new URL("/api/plaid/sync", base);
} catch {
  fail("BASE_URL is not a valid URL");
}
if (url.protocol !== "http:" && url.protocol !== "https:") {
  fail("BASE_URL must be http(s)");
}
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
if (!LOOPBACK.has(url.hostname) && !allowRemote) {
  fail(
    "BASE_URL is not loopback; the bearer secret would leave this machine. Pass --allow-remote to override."
  );
}

const SAFE_CODE = /^[\w .:-]{1,64}$/;

async function main() {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    redirect: "error", // never forward the secret to a redirect target
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const code = body?.error?.code;
    fail(`failed (http ${res.status}${typeof code === "string" && SAFE_CODE.test(code) ? `, ${code}` : ""})`);
  }

  let failed = 0;
  for (const item of Array.isArray(body?.items) ? body.items : []) {
    const id = String(item.item_id ?? "?").slice(0, 64);
    if (item.ok) {
      console.log(`item=${id} ok added=${item.added} modified=${item.modified} removed=${item.removed}`);
    } else {
      failed++;
      const code = typeof item.error_code === "string" && SAFE_CODE.test(item.error_code) ? item.error_code : "unknown";
      console.log(`item=${id} failed code=${code}`);
    }
  }
  const t = body?.totals ?? {};
  console.log(`total added=${t.added ?? 0} modified=${t.modified ?? 0} removed=${t.removed ?? 0} failed=${failed}`);
  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  // Network errors only: print the error name/code, never the message (may embed the URL/headers).
  fail(`request failed (${err?.cause?.code ?? err?.name ?? "error"})`);
});
