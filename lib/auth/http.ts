// Tiny JSON response helpers for auth code. Every auth response is
// `Cache-Control: no-store`; error bodies are `{ error: { code } }` only.
import { readJsonBody } from "../http/body";

export function jsonNoStore(body: unknown, status = 200, extra?: Record<string, string>): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorJson(status: number, code: string, extra?: Record<string, string>): Response {
  return jsonNoStore({ error: { code } }, status, extra);
}

/**
 * Parse a JSON object body under the 64 KiB cap (lib/http/body.ts). Anything that is not an
 * object (invalid JSON, arrays, null, empty) becomes `{}` so callers can validate fields; an
 * oversized body is answered with the 413 `payload_too_large` Response, which the caller
 * must return as-is (`if (body instanceof Response) return body;`).
 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.code === "payload_too_large" ? parsed.response : {};
  const v = parsed.value;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
