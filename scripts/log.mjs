// Minimal JSON-line logger for the .mjs scripts (they cannot import lib/log.ts).
// Same contract as lib/log.ts: { t, level, event, ...fields }, info -> stdout,
// warn/error -> stderr, sensitive keys and Plaid token shapes redacted.
// lib/log.ts is the canonical implementation; keep the two regexes in sync.

const SENSITIVE_KEY_RE = /token|secret|password|cookie|authorization|set-cookie|key$/i;
const PLAID_TOKEN_RE = /(access|public|link)-(sandbox|development|production)-[A-Za-z0-9-]+/;
const REDACTED = "[redacted]";

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return PLAID_TOKEN_RE.test(value) ? REDACTED : value;
  if (typeof value !== "object") return value;
  if (depth >= 6) return "[depth]";
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

function write(level, event, fields) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    event,
    ...(fields ? redact(fields) : {}),
  });
  (level === "info" ? process.stdout : process.stderr).write(line + "\n");
}

export const log = {
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
};
