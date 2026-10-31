import "server-only";
import { NextResponse } from "next/server";
import { logEvent } from "./log-shim";

/**
 * Every API error is `{ error: { code, ...extra } }`. `code` is a short stable string the
 * browser can show; never put provider text, messages, tokens or request configs in `extra`.
 */
export function apiError(
  status: number,
  code: string,
  extra?: Record<string, unknown>,
  init?: { headers?: Record<string, string> }
): NextResponse {
  return NextResponse.json({ error: { code, ...extra } }, { status, headers: init?.headers });
}

// Only strings shaped like Plaid enums / ids survive extraction, so arbitrary text can never
// ride along into logs, DB rows or responses.
const ENUM = /^[A-Z0-9_]{1,64}$/;
const REQUEST_ID = /^[\w-]{1,64}$/;

export interface ProviderErrorInfo {
  error_code?: string;
  error_type?: string;
  request_id?: string;
  status?: number;
}

/**
 * Pulls the allowlisted fields out of an axios-style Plaid error
 * (`err.response.data.{error_code,error_type,request_id}`, `err.response.status`).
 * Never reads `error_message`, `config`, `request` or headers.
 */
export function extractProviderError(err: unknown): ProviderErrorInfo {
  const response = (err as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  const data = (response?.data ?? null) as Record<string, unknown> | null;
  const out: ProviderErrorInfo = {};
  if (data && typeof data === "object") {
    if (typeof data.error_code === "string" && ENUM.test(data.error_code)) {
      out.error_code = data.error_code;
    }
    if (typeof data.error_type === "string" && ENUM.test(data.error_type)) {
      out.error_type = data.error_type;
    }
    if (typeof data.request_id === "string" && REQUEST_ID.test(data.request_id)) {
      out.request_id = data.request_id;
    }
  }
  if (typeof response?.status === "number") out.status = response.status;
  return out;
}

const PROVIDER_MAP: Record<string, { code: string; status: number }> = {
  ITEM_LOGIN_REQUIRED: { code: "relink_required", status: 409 },
  INVALID_ACCESS_TOKEN: { code: "relink_required", status: 409 },
  ADDITIONAL_CONSENT_REQUIRED: { code: "consent_required", status: 409 },
  RATE_LIMIT_EXCEEDED: { code: "rate_limited", status: 429 },
  ITEM_NOT_FOUND: { code: "item_not_found", status: 404 },
};

/** Stable client code and HTTP status for a Plaid `error_code` (default: provider_error / 502). */
export function mapProviderCode(provider_code: string | undefined): { code: string; status: number } {
  return (provider_code && PROVIDER_MAP[provider_code]) || { code: "provider_error", status: 502 };
}

/** HTTP status for one of our own client codes (used when a handler surfaces a SyncError). */
export function statusForCode(code: string): number {
  const hit = Object.values(PROVIDER_MAP).find((m) => m.code === code);
  return hit ? hit.status : 502;
}

/**
 * Turn any error thrown by a provider call into a safe response. Logs only
 * `{ route, item_id, error_code, error_type, request_id, status }` and audits nothing.
 */
export function handleProviderError(
  err: unknown,
  ctx: { route: string; item_id?: string }
): NextResponse {
  const info = extractProviderError(err);
  logEvent("provider_error", {
    route: ctx.route,
    item_id: ctx.item_id,
    error_code: info.error_code,
    error_type: info.error_type,
    request_id: info.request_id,
    status: info.status,
  });
  const mapped = mapProviderCode(info.error_code);
  const headers = mapped.status === 429 ? { "Retry-After": "60" } : undefined;
  return apiError(
    mapped.status,
    mapped.code,
    info.error_code ? { provider_code: info.error_code } : undefined,
    { headers }
  );
}
