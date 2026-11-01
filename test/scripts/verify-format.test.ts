import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIELD_KEYS as APP_FIELD_KEYS } from "@/lib/providers/types";
import accountsGet from "../fixtures/plaid/accounts_get.json";
import liabilitiesGet from "../fixtures/plaid/liabilities_get.json";
// @ts-expect-error plain ESM script helpers, no type declarations
import * as fmt from "../../scripts/lib/verify-format.mjs";

const TOKEN = /(access|public|link)-(sandbox|development|production)-/;
const ACCESS = "access-sandbox-0a1b2c3d-4e5f-6789-abcd-ef0123456789";

describe("verify-format: field presence", () => {
  it("covers exactly the app's 11 field keys", () => {
    expect([...fmt.FIELD_KEYS]).toEqual([...APP_FIELD_KEYS]);
    expect(fmt.FIELD_KEYS).toHaveLength(11);
  });

  it("reports present / null per key and treats is_overdue=false and 0 as present", () => {
    const account = { account_id: "a", type: "credit", balances: { current: 0, available: null, limit: 5000 } };
    const p = fmt.fieldPresence(account, {
      last_statement_balance: null,
      minimum_payment_amount: 25,
      next_payment_due_date: "2026-11-10",
      last_payment_amount: null,
      last_payment_date: "",
      is_overdue: false,
      aprs: [],
    });
    expect(p).toEqual({
      current_balance: "present",
      available_credit: "null",
      credit_limit: "present",
      statement_balance: "null",
      minimum_payment: "present",
      next_payment_due_date: "present",
      last_payment_amount: "null",
      last_payment_date: "null",
      last_statement_issue_date: "null",
      is_overdue: "present",
      apr: "null",
    });
    expect(fmt.fieldPresence(account, undefined).minimum_payment).toBe("null");
    expect(fmt.fieldPresence(account, { aprs: [{ apr_percentage: 1 }] }).apr).toBe("present");
  });
});

describe("verify-format: report output", () => {
  it("prints mask, currency and presence per credit account, never values", () => {
    const lines = fmt.formatAccountReport(accountsGet.accounts, liabilitiesGet.liabilities.credit) as string[];
    const text = lines.join("\n");
    expect(text).toContain("credit account 1: mask=1005 currency=CAD");
    expect(text).toContain("credit account 2: mask=4321 currency=USD");
    expect(lines.filter((l) => /^ {2}\w+: (present|null)$/.test(l))).toHaveLength(22);
    // values and forbidden fields in the fixture never appear
    for (const forbidden of ["1500.18", "8499.82", "10000", "371449635398431", "123456789", "Pat Example", "20.99"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("never emits a Plaid token, even when one is planted in every input", () => {
    const accounts = [
      {
        account_id: ACCESS,
        type: "credit",
        mask: ACCESS,
        name: ACCESS,
        balances: { current: 1, iso_currency_code: ACCESS },
      },
    ];
    const credit = [{ account_id: ACCESS, next_payment_due_date: ACCESS, aprs: [{ apr_type: ACCESS }] }];
    const text = (fmt.formatAccountReport(accounts, credit) as string[]).join("\n");
    expect(text).not.toMatch(TOKEN);
    expect(text).not.toContain("0a1b2c3d");

    expect(fmt.scrub(`token=${ACCESS} and public-development-abc-123`)).not.toMatch(TOKEN);
    expect(fmt.formatCoverage([{ id: ACCESS, found: false }]).join("\n")).not.toMatch(TOKEN);
    expect(fmt.formatCoverage([{ id: "ins_1", found: true, name: ACCESS, liabilities: "1", balance: "1", transactions: "1" }]).join("\n")).not.toMatch(TOKEN);
  });

  it("error codes: only enum-shaped Plaid codes survive", () => {
    expect(fmt.errorCodeOf({ response: { data: { error_code: "ADDITIONAL_CONSENT_REQUIRED" } } })).toBe("ADDITIONAL_CONSENT_REQUIRED");
    expect(fmt.errorCodeOf({ response: { data: { error_code: `bad ${ACCESS}` } } })).toBe("UNKNOWN");
    expect(fmt.errorCodeOf(new Error(ACCESS))).toBe("UNKNOWN");
  });

  it("says so when there are no credit accounts", () => {
    expect(fmt.formatAccountReport([{ type: "depository", balances: {} }], [])).toEqual(["no credit accounts returned"]);
  });
});

describe("verify-format: CSV", () => {
  it("parses quoted commas, doubled quotes, embedded newlines, CRLF and a BOM", () => {
    const text = '﻿a,b,c\r\n1,"x, y",3\r\n"he said ""hi""","line1\nline2",\r\n';
    expect(fmt.parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", "3"],
      ['he said "hi"', "line1\nline2", ""],
    ]);
  });

  it("skips `#` comment lines at record starts, but not a # inside a field", () => {
    expect(fmt.parseCsv("# Generated on: 2026-10-16\na,b\n#x,y\n1,#2\n")).toEqual([
      ["a", "b"],
      ["1", "#2"],
    ]);
  });

  it("looks up institutions by header name, with quoted commas in the name", () => {
    const csv = [
      "# Generated on: 2026-10-16T03:26:16.866Z",
      "institution_id,name,country,balance,liabilities,transactions",
      'ins_100533,"American Express (Canada), Ltd",CA,1,1,1',
      "ins_46,Desjardins,CA,1,0,1",
    ].join("\n");
    const got = fmt.coverageFor(csv, ["ins_100533", "ins_46", "ins_missing"]);
    expect(got).toEqual([
      { id: "ins_100533", found: true, name: "American Express (Canada), Ltd", country: "CA", liabilities: "1", balance: "1", transactions: "1" },
      { id: "ins_46", found: true, name: "Desjardins", country: "CA", liabilities: "0", balance: "1", transactions: "1" },
      { id: "ins_missing", found: false, liabilities: null, balance: null, transactions: null },
    ]);
    expect(fmt.formatCoverage(got)).toEqual([
      "ins_100533 (American Express (Canada), Ltd, CA): liabilities=1 balance=1 transactions=1",
      "ins_46 (Desjardins, CA): liabilities=0 balance=1 transactions=1",
      "ins_missing: not in coverage file",
    ]);
  });

  it("parseCoverageIds accepts ins_ ids only", () => {
    expect(fmt.parseCoverageIds("ins_100533, ins_39")).toEqual(["ins_100533", "ins_39"]);
    expect(fmt.parseCoverageIds("")).toBeNull();
    expect(fmt.parseCoverageIds("ins_1,../etc/passwd")).toBeNull();
    expect(fmt.parseCoverageIds(undefined)).toBeNull();
  });
});

describe("scripts/verify-sandbox.mjs guards", () => {
  const script = path.join(process.cwd(), "scripts", "verify-sandbox.mjs");
  const run = (env: Record<string, string>, args: string[] = []) =>
    spawnSync(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 15_000,
    });

  it.each(["production", "development", ""])("refuses PLAID_ENV=%j before any network call", (PLAID_ENV) => {
    const r = run({ PLAID_ENV, PLAID_CLIENT_ID: "x", PLAID_SECRET: "x" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("sandbox");
  });

  it("exits 1 without sandbox keys and on a malformed --coverage list", () => {
    expect(run({ PLAID_ENV: "sandbox" }).status).toBe(1);
    const bad = run({ PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "x", PLAID_SECRET: "x" }, ["--coverage", "nope"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("--coverage");
  });
});
