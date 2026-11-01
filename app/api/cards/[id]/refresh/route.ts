import { NextResponse } from "next/server";
import { requireMutation } from "@/lib/auth/guard";
import { refreshItemCards } from "@/lib/cards/refresh";
import { getCardsResponse } from "@/lib/cards/view";
import { getDB } from "@/lib/db";
import { apiError, handleProviderError, mapProviderCode } from "@/lib/http/errors";
import { rateLimited } from "@/lib/http/rate-limit";
import { withItemLock } from "@/lib/sync/lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The ONLY path that asks Plaid for a live balance (`/accounts/balance/get`, billed per call).
// Syncs and cron use the free cached `/accounts/get`. One live refresh per card per 10 minutes.
const BALANCE_WINDOW_MS = 10 * 60_000;
const ID = /^[\w-]{1,64}$/;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!ID.test(id)) return apiError(404, "card_not_found");

  // Look up first so unknown ids cannot mint rate-limit buckets.
  const db = await getDB();
  const account = await db.getAccountById(id);
  if (!account) return apiError(404, "card_not_found");

  const limited = rateLimited("balance:" + id, 1, BALANCE_WINDOW_MS);
  if (limited) return limited;

  let outcome;
  try {
    // Serialise with any in-flight sync of the same item (syncItem holds this lock while it
    // refreshes cards itself, so refreshItemCards must not take it).
    outcome = await withItemLock(account.item_id, () =>
      refreshItemCards(account.item_id, { realtimeBalance: true })
    );
  } catch (err) {
    return handleProviderError(err, { route: "cards/refresh", item_id: account.item_id });
  }

  if (!outcome.ok) {
    return outcome.code === "item_not_found"
      ? apiError(404, "card_not_found")
      : apiError(409, outcome.code ?? "refresh_failed");
  }
  if (!outcome.accounts_fetched) {
    // Stored cards are untouched; surface the provider code through the stable map.
    const mapped = mapProviderCode(outcome.error_code ?? undefined);
    return apiError(
      mapped.status,
      mapped.code,
      outcome.error_code ? { provider_code: outcome.error_code } : undefined
    );
  }

  const view = await getCardsResponse();
  const card = view.cards.find((c) => c.account_ids.includes(id)) ?? null;
  return NextResponse.json({
    card,
    refresh: {
      balance_source: outcome.balance_source,
      liabilities_status: outcome.liabilities_status,
      error_code: outcome.error_code,
    },
    today: view.today,
    generated_at: view.generated_at,
  });
}
