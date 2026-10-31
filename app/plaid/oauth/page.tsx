"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from "react-plaid-link";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import {
  clearLinkSession,
  completeLink,
  isLinkAffectedKey,
  loadLinkSession,
  type StoredLink,
} from "@/lib/client/plaid-link";

/**
 * OAuth return page (PLAID_REDIRECT_URI). The institution sent the browser back here with an
 * `oauth_state_id` in the URL; Link must be re-opened with the SAME link token (kept in
 * sessionStorage by PlaidLinkButton, never in a URL) and the full received URL.
 */
export default function PlaidOAuthPage() {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  // undefined: not read yet (server render / first paint); null: nothing usable stored.
  const [link, setLink] = useState<StoredLink | null | undefined>(undefined);
  const [receivedRedirectUri, setReceivedRedirectUri] = useState<string | undefined>(undefined);
  const opened = useRef(false);

  useEffect(() => {
    setLink(loadLinkSession());
    setReceivedRedirectUri(window.location.href);
  }, []);

  const onSuccess: PlaidLinkOnSuccess = async (public_token) => {
    const current = link;
    clearLinkSession();
    if (current) {
      await completeLink({ mode: current.mode, item_id: current.item_id, public_token });
      mutate(isLinkAffectedKey);
    }
    router.replace("/settings");
  };

  const onExit: PlaidLinkOnExit = (err) => {
    clearLinkSession();
    if (err) toast.error(`Plaid Link exited (${err.error_code || "unknown"})`);
    router.replace("/settings");
  };

  const { open, ready } = usePlaidLink({
    token: link?.token ?? null,
    receivedRedirectUri,
    onSuccess,
    onExit,
  });

  useEffect(() => {
    if (!link || !receivedRedirectUri || !ready || opened.current) return;
    opened.current = true;
    open();
  }, [link, receivedRedirectUri, ready, open]);

  if (link === null) {
    return (
      <div className="neo-card space-y-3 p-6 text-sm">
        <p className="text-slate-200">Link session expired. Start again from Settings.</p>
        <button
          onClick={() => router.replace("/settings")}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
        >
          Back to Settings
        </button>
      </div>
    );
  }
  return <div className="neo-card p-6 text-sm text-slate-400">Finishing bank connection…</div>;
}
