import { REQUEST_HEADER } from "@/lib/client/api";

export const ORIGIN = "http://localhost:3000";
export const SETUP_TOKEN = "setup-token-for-tests-0123456789abcdef"; // 38 chars
export const COOKIE_NAME = "__Host-amexlens_session";

/** loadApp(...) overrides that turn authentication on. */
export const REQUIRED_ENV = {
  AUTH_MODE: "required",
  APP_ORIGIN: ORIGIN,
  AUTH_SETUP_TOKEN: SETUP_TOKEN,
};

export interface ReqOptions {
  method?: string;
  /** raw session token; becomes `Cookie: __Host-amexlens_session=<token>` */
  token?: string | null;
  /** full Cookie header, used instead of `token` when given */
  cookie?: string | null;
  /** Origin header; `undefined` → ORIGIN, `null` → omitted */
  origin?: string | null;
  referer?: string;
  /** include the X-AmexLens-Request header (default true for non-GET) */
  csrfHeader?: boolean;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Build a Request against the test origin with the usual auth/CSRF headers. */
export function makeReq(path: string, opts: ReqOptions = {}): Request {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers = new Headers(opts.headers ?? {});
  if (opts.cookie) headers.set("cookie", opts.cookie);
  else if (opts.token) headers.set("cookie", `${COOKIE_NAME}=${opts.token}`);
  if (opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN);
  if (opts.referer) headers.set("referer", opts.referer);
  const wantHeader = opts.csrfHeader ?? method !== "GET";
  if (wantHeader) headers.set(REQUEST_HEADER, "1");
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers.set("content-type", "application/json");
  }
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}

/** Raw session token from a response's Set-Cookie, or null. */
export function tokenFromResponse(res: Response): string | null {
  const all = res.headers.getSetCookie();
  for (const c of all) {
    const m = /^__Host-amexlens_session=([^;]*)/.exec(c);
    if (m) return m[1] === "" ? null : m[1];
  }
  return null;
}

export function setCookieHeaders(res: Response): string[] {
  return res.headers.getSetCookie();
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
