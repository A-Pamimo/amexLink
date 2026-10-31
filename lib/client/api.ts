// Browser-side fetch seam. Every client component goes through apiFetch so that:
//  - mutating requests carry the X-AmexLens-Request header (CSRF defence, enforced server-side later),
//  - JSON is parsed in one place,
//  - failures become ApiError(status, code) carrying a short, safe error code,
//  - an expired session (401) sends the user to /login.
// Never surface raw response bodies in the UI: show a generic message plus ApiError.code.

export const REQUEST_HEADER = "X-AmexLens-Request";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Request failed (${code})`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

// Only short, token-like strings are accepted as codes; anything else falls back to http_<status>.
const SAFE_CODE = /^[\w .:-]{1,64}$/;

function extractCode(body: unknown, status: number): string {
  const fallback = `http_${status}`;
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "string") return SAFE_CODE.test(err) ? err : fallback;
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: unknown }).code;
      if (typeof code === "string" && SAFE_CODE.test(code)) return code;
    }
  }
  return fallback;
}

export async function apiFetch<T = unknown>(
  url: string,
  init: RequestInit = {}
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET") headers.set(REQUEST_HEADER, "1");
  if (typeof init.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(url, { ...init, method, headers });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    if (
      res.status === 401 &&
      typeof window !== "undefined" &&
      !window.location.pathname.startsWith("/login")
    ) {
      // Already on /login: a 401 there is a failed sign-in, not an expired session.
      window.location.assign("/login");
    }
    throw new ApiError(res.status, extractCode(body, res.status));
  }
  return body as T;
}

export const swrFetcher = <T = unknown>(url: string) => apiFetch<T>(url);

/** "Sync failed (http_500)": generic message + error code, never raw response text. */
export function errorMessage(prefix: string, err: unknown): string {
  return err instanceof ApiError ? `${prefix} (${err.code})` : prefix;
}
