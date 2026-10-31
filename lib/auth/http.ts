// Tiny JSON response helpers for auth code. Every auth response is
// `Cache-Control: no-store`; error bodies are `{ error: { code } }` only.

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

/** Parse a JSON object body; anything else becomes `{}` so callers can validate fields. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
