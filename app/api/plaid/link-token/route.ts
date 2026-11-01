import { NextResponse } from "next/server";
import type { LinkTokenCreateRequest } from "plaid";
import { requireMutation } from "@/lib/auth/guard";
import { getDB } from "@/lib/db";
import { env } from "@/lib/env";
import { TokenUnreadableError } from "@/lib/errors";
import { apiError, handleProviderError } from "@/lib/http/errors";
import { HOUR_MS, rateLimited } from "@/lib/http/rate-limit";
import {
  assertLeastPrivilege,
  getPlaid,
  LINK_ACCOUNT_FILTERS,
  LINK_ADDITIONAL_CONSENTED,
  LINK_PRODUCTS,
  LINK_REQUIRED_IF_SUPPORTED,
  plaidCountryCodes,
} from "@/lib/plaid";
import { getOrCreateClientUserId } from "@/lib/plaid-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Mode = "new" | "consent" | "repair";
const MODES: readonly Mode[] = ["new", "consent", "repair"];

/**
 * Link token for one of three flows (SECURITY.md 3.5, P-S4: the route needs a session):
 *  - `new`:     products=[transactions], required_if_supported=[liabilities], credit cards only.
 *  - `consent`: update mode for an existing Item: `access_token` + additional_consented_products
 *               =[liabilities], and NO `products` array (that is what makes it an add-consent flow).
 *  - `repair`:  update mode for ITEM_LOGIN_REQUIRED: `access_token` alone.
 * `webhook` is never sent. `redirect_uri` is sent only when PLAID_REDIRECT_URI is configured.
 */
export async function POST(req: Request) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;

  const limited = rateLimited("link-token", 10, HOUR_MS);
  if (limited) return limited;

  let body: { mode?: unknown; item_id?: unknown } = {};
  try {
    const text = await req.text();
    if (text.trim() !== "") {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return apiError(400, "invalid_json");
      }
      body = parsed as typeof body;
    }
  } catch {
    return apiError(400, "invalid_json");
  }

  const mode: Mode = body.mode === undefined ? "new" : (body.mode as Mode);
  if (!MODES.includes(mode)) return apiError(400, "invalid_mode");

  let access_token: string | undefined;
  let itemId: string | undefined;
  if (mode !== "new") {
    if (typeof body.item_id !== "string" || body.item_id === "" || body.item_id.length > 128) {
      return apiError(400, "item_id_required");
    }
    itemId = body.item_id;
    try {
      const secret = await (await getDB()).getItemSecret(itemId);
      if (!secret) return apiError(404, "item_not_found");
      access_token = secret.access_token;
    } catch (err) {
      if (err instanceof TokenUnreadableError) return apiError(409, "credential_unavailable");
      throw err;
    }
  }

  // Defence in depth: the base lists are checked at boot, these are the per-mode lists.
  assertLeastPrivilege(
    mode === "new"
      ? {
          products: LINK_PRODUCTS,
          requiredIfSupported: LINK_REQUIRED_IF_SUPPORTED,
          accountFilters: LINK_ACCOUNT_FILTERS,
        }
      : {
          products: [],
          requiredIfSupported: [],
          additionalConsented: mode === "consent" ? LINK_ADDITIONAL_CONSENTED : [],
        }
  );

  const request: LinkTokenCreateRequest = {
    user: { client_user_id: await getOrCreateClientUserId() },
    client_name: "AmexLens",
    country_codes: plaidCountryCodes(),
    language: "en",
  };
  if (mode === "new") {
    request.products = LINK_PRODUCTS;
    request.required_if_supported_products = LINK_REQUIRED_IF_SUPPORTED;
    request.account_filters = LINK_ACCOUNT_FILTERS;
  } else {
    request.access_token = access_token;
    if (mode === "consent") request.additional_consented_products = LINK_ADDITIONAL_CONSENTED;
  }
  if (env.PLAID_REDIRECT_URI) request.redirect_uri = env.PLAID_REDIRECT_URI;

  try {
    const res = await getPlaid().linkTokenCreate(request);
    return NextResponse.json({
      link_token: res.data.link_token,
      expiration: res.data.expiration,
      mode,
    });
  } catch (err) {
    return handleProviderError(err, { route: "plaid/link-token", item_id: itemId });
  }
}
