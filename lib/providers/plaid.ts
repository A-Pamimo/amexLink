import "server-only";
import { extractProviderError } from "../http/errors";
import { log } from "../log";
import { getPlaid } from "../plaid";
import {
  buildCard,
  mapLiabilitiesError,
  pickAccount,
  pickLiability,
  type LiabilitiesFailure,
  type PickedAccount,
  type PickedLiability,
} from "./plaid-fields";
import type { BalanceSource, CardProvider, ProviderRefresh } from "./types";

/**
 * Plaid card adapter (docs/ARCHITECTURE.md section 3).
 *
 *  1. Accounts: `/accounts/balance/get` ONLY when `opts.realtimeBalance` (billed per call), else
 *     the free cached `/accounts/get`. A failed live call falls back to the cached one.
 *  2. Keep `type === "credit"` accounts only.
 *  3. `/liabilities/get` (limited to those account ids), failures mapped to a status.
 *  4. One observation per field via the explicit pickers in plaid-fields.ts.
 *
 * Never throws for provider failures, never logs response bodies, only error_code enums.
 */

function pickAll(raw: unknown): PickedAccount[] {
  if (!Array.isArray(raw)) return [];
  const out: PickedAccount[] = [];
  for (const a of raw) {
    const p = pickAccount(a);
    if (p) out.push(p);
  }
  return out;
}

async function fetchAccounts(
  access_token: string,
  realtime: boolean
): Promise<{ accounts: PickedAccount[]; source: BalanceSource; error_code: string | null }> {
  const plaid = getPlaid();
  let firstFailure: string | null = null;

  if (realtime) {
    try {
      const res = await plaid.accountsBalanceGet({ access_token });
      return { accounts: pickAll(res.data.accounts), source: "realtime", error_code: null };
    } catch (err) {
      const info = extractProviderError(err);
      firstFailure = info.error_code ?? "UNKNOWN";
      log.warn("balance_realtime_failed", {
        error_code: info.error_code,
        request_id: info.request_id,
        status: info.status,
      });
    }
  }

  try {
    const res = await plaid.accountsGet({ access_token });
    // A fallback after a failed live call is reported as the cached source.
    return { accounts: pickAll(res.data.accounts), source: "cached", error_code: null };
  } catch (err) {
    const info = extractProviderError(err);
    log.warn("accounts_get_failed", {
      error_code: info.error_code,
      request_id: info.request_id,
      status: info.status,
    });
    return { accounts: [], source: "error", error_code: info.error_code ?? firstFailure ?? "UNKNOWN" };
  }
}

async function fetchLiabilities(
  access_token: string,
  account_ids: string[]
): Promise<{ failure: LiabilitiesFailure | null; byAccount: Map<string, PickedLiability> }> {
  const byAccount = new Map<string, PickedLiability>();
  if (account_ids.length === 0) {
    // Nothing to ask about; Plaid would answer NO_LIABILITY_ACCOUNTS.
    return { failure: mapLiabilitiesError("NO_LIABILITY_ACCOUNTS"), byAccount };
  }
  try {
    const res = await getPlaid().liabilitiesGet({ access_token, options: { account_ids } });
    const credit: unknown = (res.data.liabilities as { credit?: unknown } | undefined)?.credit;
    if (Array.isArray(credit)) {
      for (const c of credit) {
        const l = pickLiability(c);
        if (l) byAccount.set(l.account_id, l);
      }
    }
    return { failure: null, byAccount };
  } catch (err) {
    const info = extractProviderError(err);
    log.warn("liabilities_get_failed", {
      error_code: info.error_code,
      error_type: info.error_type,
      request_id: info.request_id,
      status: info.status,
    });
    return { failure: mapLiabilitiesError(info.error_code), byAccount };
  }
}

export const plaidProvider: CardProvider = {
  id: "plaid",
  async refresh(secret, opts): Promise<ProviderRefresh> {
    const observed_at = new Date().toISOString();
    try {
      const { accounts, source, error_code } = await fetchAccounts(
        secret.access_token,
        opts.realtimeBalance
      );
      if (source === "error") {
        return {
          accounts_fetched: false,
          balance_source: "error",
          liabilities_status: "error",
          error_code,
          cards: [],
        };
      }

      const credit = accounts.filter((a) => a.type === "credit");
      const { failure, byAccount } = await fetchLiabilities(
        secret.access_token,
        credit.map((a) => a.provider_account_id)
      );

      return {
        accounts_fetched: true,
        balance_source: source,
        liabilities_status: failure ? failure.status : "ok",
        error_code: failure ? failure.error_code : null,
        cards: credit.map((a) =>
          buildCard(a, byAccount.get(a.provider_account_id) ?? null, failure, observed_at)
        ),
      };
    } catch (err) {
      // Defensive: pickers never throw, but "never throw out of refresh" is a contract.
      const info = extractProviderError(err);
      log.warn("provider_refresh_failed", { error_code: info.error_code });
      return {
        accounts_fetched: false,
        balance_source: "error",
        liabilities_status: "error",
        error_code: info.error_code ?? "UNKNOWN",
        cards: [],
      };
    }
  },
};
