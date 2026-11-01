#!/usr/bin/env node
// Sandbox verifier: proves, against Plaid's SANDBOX only, which of the 11 card fields a linked
// credit account actually carries. It talks to Plaid directly with the `plaid` SDK. It never
// opens the app database and never reads TOKEN_ENCRYPTION_KEY.
//
//   npm run verify:sandbox
//   npm run verify:sandbox -- --balance                 also call /accounts/balance/get (billed in production, free here)
//   npm run verify:sandbox -- --with-liabilities        create the sandbox Item with liabilities consent
//   npm run verify:sandbox -- --coverage ins_100533,ins_39
//                                                       print the liabilities / balance / transactions
//                                                       flags from Plaid's coverage CSV for those ids
//
// Output is field PRESENCE ("present" / "null"), never values, and nothing that looks like a Plaid
// token. The sandbox Item is removed in a `finally`. Exit 0 on success, 1 on any failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Configuration, PlaidApi, PlaidEnvironments, Products } from "plaid";
import {
  coverageFor,
  errorCodeOf,
  formatAccountReport,
  formatCoverage,
  parseCoverageIds,
  scrub,
} from "./lib/verify-format.mjs";

const COVERAGE_URL = "https://plaid.com/documents/us_institution_coverage.csv";
const COVERAGE_MAX_BYTES = 20 * 1024 * 1024;
// "First Platypus Bank" in Plaid's sandbox, and the documented sandbox login.
const SANDBOX_INSTITUTION = "ins_109508";
const SANDBOX_USERNAME = "user_good";
const SANDBOX_PASSWORD = "pass_good";

const out = (line = "") => console.log(scrub(line));
const err = (line) => console.error(scrub(line));

function parseArgs(argv) {
  const opts = { balance: false, withLiabilities: false, coverage: null, bad: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--balance") opts.balance = true;
    else if (a === "--with-liabilities") opts.withLiabilities = true;
    else if (a === "--coverage") {
      const ids = parseCoverageIds(argv[++i]);
      if (!ids) opts.bad = "--coverage needs a comma-separated list of institution ids (ins_...)";
      else opts.coverage = ids;
    } else opts.bad = `unknown argument: ${a}`;
  }
  return opts;
}

function describeFailure(step, e) {
  // Only the Plaid error_code enum (or the error class name) is ever printed.
  const code = e?.response?.data?.error_code ? errorCodeOf(e) : null;
  return code ? `${step} error_code: ${code}` : `${step} failed (${e?.name ?? "error"})`;
}

async function runSandbox(opts) {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    err("PLAID_CLIENT_ID and PLAID_SECRET are required (sandbox keys).");
    return false;
  }
  const plaid = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments.sandbox,
      baseOptions: { headers: { "PLAID-CLIENT-ID": clientId, "PLAID-SECRET": secret } },
    })
  );

  let access_token = null;
  let ok = true;
  try {
    const initial_products = [Products.Transactions];
    if (opts.withLiabilities) initial_products.push(Products.Liabilities);
    const created = await plaid.sandboxPublicTokenCreate({
      institution_id: SANDBOX_INSTITUTION,
      initial_products,
      options: { override_username: SANDBOX_USERNAME, override_password: SANDBOX_PASSWORD },
    });
    const exchanged = await plaid.itemPublicTokenExchange({
      public_token: created.data.public_token,
    });
    access_token = exchanged.data.access_token;
    out(`sandbox item created (${SANDBOX_INSTITUTION}, products: ${initial_products.join(",")})`);

    let accounts = [];
    try {
      const res = opts.balance
        ? await plaid.accountsBalanceGet({ access_token })
        : await plaid.accountsGet({ access_token });
      accounts = res.data.accounts;
      out(`${opts.balance ? "/accounts/balance/get" : "/accounts/get"}: ok`);
    } catch (e) {
      err(describeFailure("accounts", e));
      ok = false;
    }

    let credit = [];
    try {
      const res = await plaid.liabilitiesGet({ access_token });
      credit = res.data.liabilities?.credit ?? [];
      out("/liabilities/get: ok");
    } catch (e) {
      err(describeFailure("liabilities", e));
      if (errorCodeOf(e) === "ADDITIONAL_CONSENT_REQUIRED") {
        err("  the sandbox Item was created without liabilities consent; rerun with --with-liabilities");
      }
      ok = false;
    }

    for (const line of formatAccountReport(accounts, credit)) out(line);
  } catch (e) {
    err(describeFailure("sandbox setup", e));
    ok = false;
  } finally {
    if (access_token) {
      try {
        await plaid.itemRemove({ access_token });
        out("sandbox item removed");
      } catch (e) {
        err(describeFailure("item remove", e));
        ok = false;
      }
    }
  }
  return ok;
}

async function runCoverage(ids) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-coverage-"));
  const file = path.join(dir, "us_institution_coverage.csv");
  try {
    const res = await fetch(COVERAGE_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      err(`coverage download failed (http ${res.status})`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > COVERAGE_MAX_BYTES) {
      err("coverage file larger than expected; refusing to parse");
      return false;
    }
    fs.writeFileSync(file, buf, { mode: 0o600 });
    out("coverage (1 = listed for the product):");
    for (const line of formatCoverage(coverageFor(fs.readFileSync(file, "utf8"), ids))) {
      out(`  ${line}`);
    }
    return true;
  } catch (e) {
    err(`coverage download failed (${e?.name ?? "error"})`);
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.bad) {
    err(opts.bad);
    return 1;
  }
  if (process.env.PLAID_ENV !== "sandbox") {
    err(`Refusing to run: PLAID_ENV must be "sandbox" (got "${process.env.PLAID_ENV ?? ""}").`);
    return 1;
  }
  let ok = await runSandbox(opts);
  if (opts.coverage) ok = (await runCoverage(opts.coverage)) && ok;
  return ok ? 0 : 1;
}

process.exitCode = await main();
