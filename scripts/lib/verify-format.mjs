// Pure formatting and CSV helpers for scripts/verify-sandbox.mjs. No network, no env, no I/O, so
// they are unit-testable offline (test/scripts/verify-format.test.ts).
//
// Contract: nothing here ever emits a field VALUE. A field is reported as "present" or "null",
// and every line that leaves this module passes through `scrub`, so even a Plaid token that
// somehow ended up in an input cannot be printed.

/** Mirrors FIELD_KEYS in lib/providers/types.ts (a test keeps the two in sync). */
export const FIELD_KEYS = [
  "current_balance",
  "available_credit",
  "credit_limit",
  "statement_balance",
  "minimum_payment",
  "next_payment_due_date",
  "last_payment_amount",
  "last_payment_date",
  "last_statement_issue_date",
  "is_overdue",
  "apr",
];

const TOKEN_RE = /(access|public|link)-(sandbox|development|production)-[A-Za-z0-9-]+/g;
const REDACTED = "[redacted]";

/** Replaces anything shaped like a Plaid access/public/link token. */
export function scrub(text) {
  return String(text).replace(TOKEN_RE, REDACTED);
}

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const hasNumber = (v) => typeof v === "number" && Number.isFinite(v);
const hasString = (v) => typeof v === "string" && v !== "";

/**
 * Which of the 11 field keys does this credit account + liability carry?
 * Returns `{ key: "present" | "null" }`. Values are looked at only to decide that, never copied.
 * `liability` may be null/undefined (liabilities call failed or returned nothing for the account).
 */
export function fieldPresence(account, liability) {
  const balances = isObj(account) && isObj(account.balances) ? account.balances : {};
  const l = isObj(liability) ? liability : {};
  const present = {
    current_balance: hasNumber(balances.current),
    available_credit: hasNumber(balances.available),
    credit_limit: hasNumber(balances.limit),
    statement_balance: hasNumber(l.last_statement_balance),
    minimum_payment: hasNumber(l.minimum_payment_amount),
    next_payment_due_date: hasString(l.next_payment_due_date),
    last_payment_amount: hasNumber(l.last_payment_amount),
    last_payment_date: hasString(l.last_payment_date),
    last_statement_issue_date: hasString(l.last_statement_issue_date),
    // false is a real answer
    is_overdue: typeof l.is_overdue === "boolean",
    apr: Array.isArray(l.aprs) && l.aprs.length > 0,
  };
  const out = {};
  for (const k of FIELD_KEYS) out[k] = present[k] ? "present" : "null";
  return out;
}

/** `Plaid error_code` enums only: anything else is dropped. */
export function safeCode(code) {
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "UNKNOWN";
}

/** Extracts the Plaid `error_code` enum from an axios-style error, or "UNKNOWN". */
export function errorCodeOf(err) {
  return safeCode(err?.response?.data?.error_code);
}

/**
 * Report lines for the credit accounts: one header per account (mask and currency only), then
 * one `key: present|null` line per field. `liabilities` is the `/liabilities/get` credit array.
 */
export function formatAccountReport(accounts, liabilitiesCredit) {
  const byId = new Map();
  for (const l of Array.isArray(liabilitiesCredit) ? liabilitiesCredit : []) {
    if (isObj(l) && typeof l.account_id === "string") byId.set(l.account_id, l);
  }
  const lines = [];
  const credit = (Array.isArray(accounts) ? accounts : []).filter(
    (a) => isObj(a) && a.type === "credit"
  );
  if (credit.length === 0) lines.push("no credit accounts returned");
  credit.forEach((a, i) => {
    const mask = typeof a.mask === "string" && /^[0-9A-Za-z]{1,8}$/.test(a.mask) ? a.mask : "?";
    const cur = isObj(a.balances) ? a.balances.iso_currency_code : null;
    const currency = typeof cur === "string" && /^[A-Z]{3}$/.test(cur) ? cur : "?";
    lines.push(`credit account ${i + 1}: mask=${mask} currency=${currency}`);
    const presence = fieldPresence(a, byId.get(a.account_id));
    for (const k of FIELD_KEYS) lines.push(`  ${k}: ${presence[k]}`);
  });
  return lines.map(scrub);
}

// --- CSV ------------------------------------------------------------------------------------

/**
 * RFC 4180 parser: quoted fields may contain commas, doubled quotes and newlines; LF or CRLF;
 * optional BOM. Lines whose first character is `#` (the coverage file starts with a
 * `# Generated on:` comment) are skipped when they begin a record. Returns string[][].
 */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let atRecordStart = true;
  let skipLine = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    atRecordStart = true;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (skipLine) {
      if (c === "\n") {
        skipLine = false;
        atRecordStart = true;
      }
      continue;
    }
    if (atRecordStart && !inQuotes && c === "#") {
      skipLine = true;
      continue;
    }
    atRecordStart = false;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      inQuotes = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n") {
      endRecord();
    } else if (c === "\r") {
      if (src[i + 1] !== "\n") endRecord();
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) endRecord();
  return rows;
}

export const COVERAGE_COLUMNS = ["liabilities", "balance", "transactions"];

/**
 * Looks up institution ids in Plaid's coverage CSV. Returns one entry per requested id, in
 * order: `{ id, found, name?, country?, liabilities, balance, transactions }`, the three flags
 * being the raw cell ("1"/"0") or null when the id or column is missing.
 */
export function coverageFor(csvText, ids) {
  const rows = parseCsv(csvText);
  const header = rows[0] ?? [];
  const col = (name) => header.indexOf(name);
  const idCol = col("institution_id");
  const index = new Map();
  if (idCol >= 0) for (const r of rows.slice(1)) index.set(r[idCol], r);
  return ids.map((id) => {
    const r = index.get(id);
    const out = { id, found: Boolean(r) };
    if (r) {
      const nameCol = col("name");
      const countryCol = col("country");
      if (nameCol >= 0) out.name = r[nameCol];
      if (countryCol >= 0) out.country = r[countryCol];
    }
    for (const name of COVERAGE_COLUMNS) {
      const c = col(name);
      out[name] = r && c >= 0 ? (r[c] ?? null) : null;
    }
    return out;
  });
}

export function formatCoverage(entries) {
  return entries
    .map((e) => {
      if (!e.found) return `${e.id}: not in coverage file`;
      const flags = COVERAGE_COLUMNS.map((c) => `${c}=${e[c] ?? "?"}`).join(" ");
      const label = [e.name, e.country].filter(Boolean).join(", ");
      return `${e.id}${label ? ` (${label})` : ""}: ${flags}`;
    })
    .map(scrub);
}

/** Parses `--coverage a,b,c` (ids only, `ins_...`); returns null on a malformed list. */
export function parseCoverageIds(arg) {
  if (typeof arg !== "string") return null;
  const ids = arg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0 || !ids.every((s) => /^ins_[A-Za-z0-9]{1,32}$/.test(s))) return null;
  return ids;
}
