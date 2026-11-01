/**
 * Bounded request-body reading (red-team finding RT-01).
 *
 * Next.js route handlers put no limit on `req.json()` / `req.text()`: a caller who can reach
 * the port (no session needed on the login and setup routes) can stream gigabytes into one
 * request and the whole body is buffered in memory. Every handler that reads a body goes
 * through here instead: `Content-Length` is checked first, then the stream is read chunk by
 * chunk and cancelled the moment it passes the cap. JSON bodies in this app are tiny
 * (passkey responses are a few KB; `public_token` is capped at 512 chars), so 64 KiB is
 * generous. No framework helper, no app imports: this is shared by the auth and API routes.
 */

export const MAX_JSON_BODY_BYTES = 64 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super("request body exceeds the limit");
    this.name = "PayloadTooLargeError";
  }
}

/** Read the body as UTF-8 text, throwing PayloadTooLargeError once more than `max` bytes arrive. */
export async function readBodyText(req: Request, max: number = MAX_JSON_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new PayloadTooLargeError();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; code: "payload_too_large" | "invalid_json"; response: Response };

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Parse a JSON body under the size cap. An empty body parses as `undefined` (callers decide
 * whether that is acceptable). Oversize -> 413 `payload_too_large`; unparsable -> 400 `invalid_json`.
 */
export async function readJsonBody(
  req: Request,
  opts: { max?: number } = {}
): Promise<JsonBodyResult> {
  let text: string;
  try {
    text = await readBodyText(req, opts.max ?? MAX_JSON_BODY_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return { ok: false, code: "payload_too_large", response: errorResponse(413, "payload_too_large") };
    }
    return { ok: false, code: "invalid_json", response: errorResponse(400, "invalid_json") };
  }
  if (text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, code: "invalid_json", response: errorResponse(400, "invalid_json") };
  }
}
