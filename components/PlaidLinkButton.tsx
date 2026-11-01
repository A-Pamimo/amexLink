"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from "react-plaid-link";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { apiFetch, errorMessage } from "@/lib/client/api";
import {
  clearLinkSession,
  completeLink,
  isLinkAffectedKey,
  saveLinkSession,
  type LinkMode,
} from "@/lib/client/plaid-link";

interface Props {
  /** `new` (default) links a card; `consent` / `repair` open Link in update mode for `itemId`. */
  mode?: LinkMode;
  /** Plaid item_id; required for `consent` and `repair`. */
  itemId?: string;
  label?: string;
  /** Smaller, secondary styling for per-card rows. */
  compact?: boolean;
  onLinked?: () => void;
}

const DEFAULT_LABEL: Record<LinkMode, string> = {
  new: "Connect a card",
  consent: "Grant liabilities access",
  repair: "Reconnect",
};

export function PlaidLinkButton({ mode = "new", itemId, label, compact = false, onLinked }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const openedFor = useRef<string | null>(null);
  const { mutate } = useSWRConfig();

  const fetchToken = useCallback(async () => {
    if (mode !== "new" && !itemId) {
      toast.error("Could not start Plaid Link (item_id_required)");
      return;
    }
    setLoading(true);
    try {
      const body = await apiFetch<{ link_token: string }>("/api/plaid/link-token", {
        method: "POST",
        body: JSON.stringify(mode === "new" ? { mode } : { mode, item_id: itemId }),
      });
      setToken(body.link_token);
    } catch (err) {
      toast.error(errorMessage("Could not start Plaid Link", err));
    } finally {
      setLoading(false);
    }
  }, [mode, itemId]);

  const finish = useCallback(() => {
    clearLinkSession();
    openedFor.current = null;
    setToken(null);
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (public_token) => {
      finish();
      const ok = await completeLink({ mode, item_id: itemId ?? null, public_token });
      if (ok) onLinked?.();
      mutate(isLinkAffectedKey);
    },
    [finish, mode, itemId, mutate, onLinked]
  );

  const onExit = useCallback<PlaidLinkOnExit>(
    (err) => {
      finish();
      if (err) toast.error(`Plaid Link exited (${err.error_code || "unknown"})`);
    },
    [finish]
  );

  const { open, ready } = usePlaidLink({ token, onSuccess, onExit });

  useEffect(() => {
    if (!token || !ready || openedFor.current === token) return;
    openedFor.current = token;
    // An OAuth institution leaves this page; /plaid/oauth resumes from this record.
    saveLinkSession({ token, mode, item_id: itemId ?? null });
    open();
  }, [token, ready, open, mode, itemId]);

  const cls = compact
    ? "rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
    : "rounded-md bg-accent px-4 py-2 text-sm font-medium text-slate-950 hover:bg-accent/90 disabled:opacity-50";

  return (
    <button onClick={fetchToken} disabled={loading} className={cls}>
      {loading ? "Preparing..." : (label ?? DEFAULT_LABEL[mode])}
    </button>
  );
}
