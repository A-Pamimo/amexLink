import "server-only";
import { audit } from "../audit";
import { getDB } from "../db";
import { log } from "../log";
import { getProvider } from "../providers";
import type { BalanceSource, LiabilitiesStatus } from "../providers/types";

export interface RefreshOutcome {
  /** False when nothing could be refreshed; `code` says why (stable client code). */
  ok: boolean;
  code?: "item_not_found" | "credential_unavailable" | "provider_unavailable";
  accounts_fetched: boolean;
  balance_source: BalanceSource;
  liabilities_status: LiabilitiesStatus;
  error_code: string | null;
  /** Local account ids written by this refresh. */
  account_ids: string[];
}

const RELINK_CODES = new Set(["ITEM_LOGIN_REQUIRED", "INVALID_ACCESS_TOKEN"]);

function failed(code: NonNullable<RefreshOutcome["code"]>): RefreshOutcome {
  return {
    ok: false,
    code,
    accounts_fetched: false,
    balance_source: "error",
    liabilities_status: "error",
    error_code: null,
    account_ids: [],
  };
}

/**
 * Refreshes the card data of one Item through the Plaid adapter and stores it.
 *
 * Does NOT take the per-item lock: `syncItem` calls this while already holding it (the lock is
 * not re-entrant). Route handlers that call it directly wrap it in `withItemLock`.
 *
 * `realtimeBalance` is true only for the explicit per-card refresh route; that is the one
 * place `/accounts/balance/get` (billed per call) may be reached.
 */
export async function refreshItemCards(
  item_id: string,
  opts: { realtimeBalance?: boolean } = {}
): Promise<RefreshOutcome> {
  const realtimeBalance = opts.realtimeBalance === true;
  const db = await getDB();
  const item = await db.getItemByItemId(item_id);
  if (!item) return failed("item_not_found");

  const provider = getProvider("plaid");
  if (!provider) return failed("provider_unavailable");

  let access_token: string;
  try {
    const secret = await db.getItemSecret(item_id);
    if (!secret) return failed("credential_unavailable");
    access_token = secret.access_token;
  } catch {
    // Decrypt failures are handled (status + log) by the sync path; never log the cause here.
    log.error("cards_refresh_credential_unreadable", { item_id });
    return failed("credential_unavailable");
  }

  // Provider HTTP calls happen outside any DB transaction.
  const result = await provider.refresh({ access_token }, { realtimeBalance });

  const account_ids: string[] = [];
  if (result.accounts_fetched) {
    const ids = await db.upsertAccounts(item_id, provider.id, result.cards);
    for (const card of result.cards) {
      const account_id = ids[card.provider_account_id];
      if (!account_id) continue;
      await db.replaceAccountFields(account_id, provider.id, card.fields);
      account_ids.push(account_id);
    }
  }

  await db.setItemRefreshMeta(item_id, {
    liabilities_status: result.liabilities_status,
    balance_source: result.balance_source,
    last_refreshed_at: new Date().toISOString(),
  });

  if (item.status !== "revoke_failed") {
    if (result.liabilities_status === "consent_required") {
      await db.setItemStatus(item_id, "consent_required", result.error_code);
    } else if (!result.accounts_fetched && result.error_code && RELINK_CODES.has(result.error_code)) {
      await db.setItemStatus(item_id, "needs_relink", result.error_code);
    } else if (item.status === "consent_required" && result.liabilities_status === "ok") {
      // Consent was granted since the last attempt.
      await db.setItemStatus(item_id, "active", null);
    }
  }

  // Outcome and codes only: no balances, no names, no provider text.
  await audit("cards_refresh", {
    item_id,
    outcome: result.accounts_fetched ? result.liabilities_status : "accounts_error",
    detail: [
      `balance=${result.balance_source}`,
      `realtime=${realtimeBalance ? 1 : 0}`,
      result.error_code ? `code=${result.error_code}` : null,
    ]
      .filter(Boolean)
      .join(";"),
  });

  return {
    ok: true,
    accounts_fetched: result.accounts_fetched,
    balance_source: result.balance_source,
    liabilities_status: result.liabilities_status,
    error_code: result.error_code,
    account_ids,
  };
}
