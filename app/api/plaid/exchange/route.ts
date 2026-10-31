import { NextResponse } from "next/server";
import { requireMutation } from "@/lib/auth/guard";
import { rotateSessionOnResponse } from "@/lib/auth/session";
import { getDB } from "@/lib/db";
import { apiError, extractProviderError, handleProviderError } from "@/lib/http/errors";
import { log } from "@/lib/log";
import { HOUR_MS, rateLimited } from "@/lib/http/rate-limit";
import { newId } from "@/lib/id";
import { getPlaid, plaidCountryCodes } from "@/lib/plaid";
import { SyncError, syncItem } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/** Best-effort revoke of an access token this database could not keep. */
async function discardToken(access_token: string, item_id: string): Promise<void> {
  try {
    await getPlaid().itemRemove({ access_token });
  } catch (err) {
    const info = extractProviderError(err);
    log.warn("exchange_discard_failed", { item_id, error_code: info.error_code, request_id: info.request_id });
  }
}

export async function POST(req: Request) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;

  const limited = rateLimited("exchange", 10, HOUR_MS);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "invalid_json");
  }
  // Only `public_token` is read. Anything else the browser sends (including institution
  // name/id) is ignored: institution metadata comes from Plaid below (SECURITY.md C-T3).
  const public_token = (body as { public_token?: unknown } | null)?.public_token;
  if (typeof public_token !== "string" || public_token === "" || public_token.length > 512) {
    return apiError(400, "public_token_required");
  }

  const plaid = getPlaid();

  let access_token: string;
  let item_id: string;
  try {
    const exchange = await plaid.itemPublicTokenExchange({ public_token });
    access_token = exchange.data.access_token;
    item_id = exchange.data.item_id;
  } catch (err) {
    return handleProviderError(err, { route: "plaid/exchange" });
  }

  // Persist before doing anything else, so a token Plaid has issued is never orphaned.
  const db = await getDB();
  let item;
  try {
    item = await db.insertItem({
      id: newId(),
      access_token,
      item_id,
      institution_name: null,
      institution_id: null,
    });
  } catch (err) {
    await discardToken(access_token, item_id);
    if (isUniqueViolation(err)) {
      log.warn("exchange_duplicate", { item_id });
      return apiError(409, "already_linked");
    }
    log.error("exchange_store_failed", { item_id });
    return apiError(500, "storage_error");
  }

  // Institution metadata from Plaid, not the browser. Non-fatal: the card is already stored.
  try {
    const got = await plaid.itemGet({ access_token });
    const institution_id = got.data.item.institution_id ?? null;
    if (institution_id) {
      const inst = await plaid.institutionsGetById({
        institution_id,
        country_codes: plaidCountryCodes(),
      });
      await db.updateItemInstitution(item_id, institution_id, inst.data.institution.name);
      item = { ...item, institution_id, institution_name: inst.data.institution.name };
    }
  } catch (err) {
    const info = extractProviderError(err);
    log.warn("exchange_institution_failed", {
      item_id,
      error_code: info.error_code,
      request_id: info.request_id,
    });
  }

  // A failed first sync must not fail the link: the item exists and can be synced again.
  let sync:
    | { ok: true; added: number; modified: number; removed: number }
    | { ok: false; code: string };
  try {
    sync = { ok: true, ...(await syncItem(item)) };
  } catch (err) {
    sync = { ok: false, code: err instanceof SyncError ? err.code : "sync_failed" };
  }

  const res = NextResponse.json({
    ok: true,
    item_id,
    institution_name: item.institution_name,
    sync,
  });
  // Linking a card is a sensitive action: rotate the session token (SECURITY.md 3.3).
  await rotateSessionOnResponse(auth, res);
  return res;
}
