import { NextResponse } from "next/server";
import { handleProviderError } from "@/lib/http/errors";
import { HOUR_MS, rateLimited } from "@/lib/http/rate-limit";
import { getPlaid, plaidCountryCodes, TRANSACTIONS_PRODUCT } from "@/lib/plaid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const limited = rateLimited("link-token", 10, HOUR_MS);
  if (limited) return limited;

  const plaid = getPlaid();
  try {
    const res = await plaid.linkTokenCreate({
      user: { client_user_id: "amexlens-local-user" },
      client_name: "AmexLens",
      products: TRANSACTIONS_PRODUCT,
      country_codes: plaidCountryCodes(),
      language: "en",
    });
    return NextResponse.json({ link_token: res.data.link_token });
  } catch (err) {
    return handleProviderError(err, { route: "plaid/link-token" });
  }
}
