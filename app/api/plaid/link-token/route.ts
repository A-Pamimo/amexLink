import { NextResponse } from "next/server";
import { requireMutation } from "@/lib/auth/guard";
import { handleProviderError } from "@/lib/http/errors";
import { HOUR_MS, rateLimited } from "@/lib/http/rate-limit";
import {
  assertLeastPrivilege,
  getPlaid,
  LINK_ACCOUNT_FILTERS,
  LINK_PRODUCTS,
  LINK_REQUIRED_IF_SUPPORTED,
  plaidCountryCodes,
} from "@/lib/plaid";
import { getOrCreateClientUserId } from "@/lib/plaid-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;

  const limited = rateLimited("link-token", 10, HOUR_MS);
  if (limited) return limited;

  // Defence in depth: the same check runs at boot.
  assertLeastPrivilege();

  const plaid = getPlaid();
  try {
    const res = await plaid.linkTokenCreate({
      user: { client_user_id: await getOrCreateClientUserId() },
      client_name: "AmexLens",
      products: LINK_PRODUCTS,
      required_if_supported_products: LINK_REQUIRED_IF_SUPPORTED,
      account_filters: LINK_ACCOUNT_FILTERS,
      country_codes: plaidCountryCodes(),
      language: "en",
    });
    return NextResponse.json({ link_token: res.data.link_token });
  } catch (err) {
    return handleProviderError(err, { route: "plaid/link-token" });
  }
}
