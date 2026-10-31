/**
 * Structured, redacting logger (SECURITY.md 3.6).
 *
 * One JSON line per event: `{ t, level, event, ...redact(fields) }`.
 * info -> stdout, warn/error -> stderr. Everything passes through `redact()`,
 * so a caller that accidentally logs a Plaid error object, an axios config or a
 * token string still cannot leak it. This module has no imports from the rest
 * of lib/ so that any module (including crypto) can use it.
 */

export type LogLevel = "info" | "warn" | "error";

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;

/** Property names whose values are never printed. */
const SENSITIVE_KEY_RE = /token|secret|password|cookie|authorization|set-cookie|key$/i;

/** Plaid credential shapes: access-/public-/link- tokens in any environment. */
const PLAID_TOKEN_RE = /(access|public|link)-(sandbox|development|production)-[A-Za-z0-9-]+/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function get(v: unknown, path: string[]): unknown {
  let cur: unknown = v;
  for (const p of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function isProviderError(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (v.isAxiosError === true) return true;
  return get(v, ["response", "data", "error_code"]) !== undefined;
}

function scalarOrUndefined(v: unknown): string | number | undefined {
  return typeof v === "string" || typeof v === "number" ? v : undefined;
}

function redactString(s: string): string {
  return PLAID_TOKEN_RE.test(s) ? REDACTED : s;
}

function redactInner(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return "[depth]";

  // Provider / HTTP client errors carry request configs (headers, bodies) and
  // response bodies. Keep only the safe identifiers.
  if (isProviderError(value)) {
    const data = get(value, ["response", "data"]);
    const status = get(value, ["response", "status"]);
    return {
      error_code: scalarOrUndefined(get(data, ["error_code"])),
      error_type: scalarOrUndefined(get(data, ["error_type"])),
      request_id: scalarOrUndefined(get(data, ["request_id"])),
      status: scalarOrUndefined(status),
    };
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redactInner(v, depth + 1);
    }
    return out;
  }

  return String(value);
}

/**
 * Deep-copies `value` with secrets removed:
 * - keys matching /token|secret|password|cookie|authorization|set-cookie|key$/i
 * - strings that look like Plaid access/public/link tokens
 * - axios / Plaid error objects reduced to { error_code, error_type, request_id, status }
 * - Error instances reduced to { name, message }
 * Depth is capped at 6.
 */
export function redact(value: unknown): unknown {
  return redactInner(value, 0);
}

function write(level: LogLevel, event: string, fields?: object): void {
  const extra = fields ? (redact(fields) as Record<string, unknown>) : {};
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...extra });
  if (level === "info") process.stdout.write(line + "\n");
  else process.stderr.write(line + "\n");
}

export const log = {
  info(event: string, fields?: object): void {
    write("info", event, fields);
  },
  warn(event: string, fields?: object): void {
    write("warn", event, fields);
  },
  error(event: string, fields?: object): void {
    write("error", event, fields);
  },
};
