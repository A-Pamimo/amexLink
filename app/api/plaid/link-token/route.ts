import { NextResponse } from "next/server";
import { getPlaid, plaidCountryCodes, TRANSACTIONS_PRODUCT } from "@/lib/plaid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
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
    const e = err as { response?: { data?: unknown }; message?: string };
    return NextResponse.json(
      { error: e?.response?.data ?? e?.message ?? "link_token failed" },
      { status: 500 }
    );
  }
}
