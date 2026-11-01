#!/usr/bin/env node
// Confirms no plaintext Plaid access token survives on disk (SECURITY.md 3.2:
// "confirm with a string search that the known token prefix is gone from data/").
//
//   npm run verify:no-plaintext            scans dirname(DB_PATH) (default data/), recursively
//   npm run verify:no-plaintext -- <dir>   scans another directory
//
// Exit 0 when clean, 1 with the offending file names when a token prefix is
// found, 2 on usage errors. Prints file names only, never file contents.
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.mjs";

const NEEDLES = ["access-sandbox-", "access-development-", "access-production-"].map((s) =>
  Buffer.from(s, "utf8")
);
const OVERLAP = Math.max(...NEEDLES.map((n) => n.length)) - 1;
const CHUNK = 1 << 20;

const dbPath = process.env.DB_PATH ?? "data/amexlens.sqlite";
const root = process.argv[2] ?? path.dirname(dbPath);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

function fileContainsNeedle(file) {
  const fd = fs.openSync(file, "r");
  try {
    let carry = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      const window = Buffer.concat([carry, buf.subarray(0, n)]);
      for (const needle of NEEDLES) {
        if (window.indexOf(needle) !== -1) return true;
      }
      carry = window.subarray(Math.max(0, window.length - OVERLAP));
      // copy so the next read does not overwrite the carried bytes
      carry = Buffer.from(carry);
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  log.error("verify_no_plaintext_refused", { reason: "directory not found", dir: root });
  process.exit(2);
}

const hits = [];
let scanned = 0;
for (const file of walk(root)) {
  scanned++;
  if (fileContainsNeedle(file)) hits.push(file);
}

if (hits.length > 0) {
  log.error("plaintext_token_found", { dir: root, scanned, files: hits });
  for (const f of hits) process.stderr.write(`PLAINTEXT TOKEN PREFIX: ${f}\n`);
  process.exit(1);
}
log.info("verify_no_plaintext_ok", { dir: root, scanned });
process.exit(0);
