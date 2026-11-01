// Browser-side helpers shared by PlaidLinkButton and the /plaid/oauth resume page.
//
// Link token handoff (docs/ARCHITECTURE.md section 4): an OAuth institution sends the browser
// away and back to PLAID_REDIRECT_URI, where the page must re-open Link with the SAME link token
// plus `receivedRedirectUri`. The token therefore lives in sessionStorage (tab-scoped, gone when
// the tab closes), never in a URL, and is cleared as soon as the flow succeeds or is dismissed.
import { toast } from "sonner";
import { apiFetch, errorMessage } from "./api";

export type LinkMode = "new" | "consent" | "repair";

export const LINK_STORAGE_KEY = "amexlens_plaid_link";
/** A Link token expires after 4 hours at Plaid; an OAuth round trip never needs more than this. */
export const LINK_MAX_AGE_MS = 30 * 60 * 1000;

export interface StoredLink {
  token: string;
  mode: LinkMode;
  /** Plaid item_id; set for `consent` and `repair`, null for `new`. */
  item_id: string | null;
  /** Epoch milliseconds when the token was handed to Link. */
  created_at: number;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const isMode = (v: unknown): v is LinkMode => v === "new" || v === "consent" || v === "repair";

export function saveLinkSession(
  link: Omit<StoredLink, "created_at">,
  opts: { now?: number; storage?: StorageLike | null } = {}
): void {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  if (!storage) return;
  const value: StoredLink = { ...link, created_at: opts.now ?? Date.now() };
  try {
    storage.setItem(LINK_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // storage full or blocked: only OAuth institutions need the record
  }
}

export function clearLinkSession(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(LINK_STORAGE_KEY);
  } catch {
    // storage unavailable: nothing to clear
  }
}

/**
 * The stored Link session, or null when it is missing, malformed or older than
 * LINK_MAX_AGE_MS (in which case it is also removed).
 */
export function loadLinkSession(
  opts: { now?: number; storage?: StorageLike | null; maxAgeMs?: number } = {}
): StoredLink | null {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(LINK_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearLinkSession(storage);
    return null;
  }
  const o = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const valid =
    typeof o.token === "string" &&
    o.token !== "" &&
    isMode(o.mode) &&
    (o.item_id === null || typeof o.item_id === "string") &&
    typeof o.created_at === "number" &&
    Number.isFinite(o.created_at);
  if (!valid) {
    clearLinkSession(storage);
    return null;
  }
  const link = o as unknown as StoredLink;
  const age = (opts.now ?? Date.now()) - link.created_at;
  if (age < 0 || age > (opts.maxAgeMs ?? LINK_MAX_AGE_MS)) {
    clearLinkSession(storage);
    return null;
  }
  return link;
}

/** SWR keys whose data changes when a card is linked, consented or repaired. */
export function isLinkAffectedKey(key: unknown): boolean {
  return (
    typeof key === "string" &&
    (key === "/api/items" ||
      key === "/api/system" ||
      key.startsWith("/api/cards") ||
      key.startsWith("/api/stats/") ||
      key.startsWith("/api/transactions"))
  );
}

/**
 * Server half of a finished Link flow:
 *  - new:     POST /api/plaid/exchange { public_token }
 *  - consent: POST /api/plaid/consent  { item_id }
 *  - repair:  POST /api/plaid/repair   { item_id }
 * Shows the outcome as a toast; resolves true when the server accepted the step.
 */
export async function completeLink(args: {
  mode: LinkMode;
  item_id: string | null;
  public_token: string | null;
}): Promise<boolean> {
  const { mode, item_id, public_token } = args;
  try {
    if (mode === "new") {
      if (!public_token) {
        toast.error("Could not finish linking (no_public_token)");
        return false;
      }
      // Only the public token goes to the server; institution metadata comes from Plaid there.
      const body = await apiFetch<{
        institution_name: string | null;
        sync: { ok: true; added: number } | { ok: false; code: string };
      }>("/api/plaid/exchange", { method: "POST", body: JSON.stringify({ public_token }) });
      const name = body.institution_name ?? "account";
      if (body.sync.ok) {
        toast.success(`Linked ${name} (synced ${body.sync.added} tx)`);
      } else {
        toast.warning(`Linked ${name}, but the first sync failed (${body.sync.code}). Try Sync again.`);
      }
      return true;
    }

    if (!item_id) {
      toast.error("Could not finish (item_id_required)");
      return false;
    }
    if (mode === "consent") {
      const body = await apiFetch<{ liabilities_status: string; item_status: string | null }>(
        "/api/plaid/consent",
        { method: "POST", body: JSON.stringify({ item_id }) }
      );
      if (body.liabilities_status === "ok") {
        toast.success("Liabilities access granted");
      } else if (body.liabilities_status === "consent_required") {
        toast.warning("Plaid still reports consent_required. Try Grant liabilities access again.");
      } else {
        toast.warning(`Consent saved, but liabilities are ${body.liabilities_status}.`);
      }
      return true;
    }

    const body = await apiFetch<{ sync: { ok: boolean; error_code?: string } }>("/api/plaid/repair", {
      method: "POST",
      body: JSON.stringify({ item_id }),
    });
    if (body.sync.ok) {
      toast.success("Reconnected");
    } else {
      toast.warning(`Reconnected, but the sync failed (${body.sync.error_code ?? "sync_failed"}).`);
    }
    return true;
  } catch (err) {
    toast.error(
      errorMessage(mode === "new" ? "Could not finish linking" : "Could not finish updating the card", err)
    );
    return false;
  }
}
