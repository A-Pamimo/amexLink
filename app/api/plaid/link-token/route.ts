import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { getPlaid, plaidCountryCodes, TRANSACTIONS_PRODUCT } from "@/lib/plaid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (!csrf.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.response?.data ?? err?.message ?? "link_token failed" },
      { status: 500 }
    );
  }
}
