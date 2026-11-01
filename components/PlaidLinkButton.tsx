"use client";
import { useCallback, useEffect, useState } from "react";
import {
  usePlaidLink,
  type PlaidLinkOnSuccess,
  type PlaidLinkOnSuccessMetadata,
} from "react-plaid-link";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { apiFetch, errorMessage } from "@/lib/client/api";

export function PlaidLinkButton({ onLinked }: { onLinked?: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { mutate } = useSWRConfig();

  const fetchToken = useCallback(async () => {
    setLoading(true);
    try {
      const body = await apiFetch<{ link_token: string }>("/api/plaid/link-token", {
        method: "POST",
      });
      setToken(body.link_token);
    } catch (err) {
      toast.error(errorMessage("Could not start Plaid Link", err));
    } finally {
      setLoading(false);
    }
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (public_token: string | null, metadata: PlaidLinkOnSuccessMetadata) => {
      if (!public_token) {
        toast.error("Could not finish linking (no_public_token)");
        return;
      }
      try {
        const body = await apiFetch<{ item_id: string; sync: { added: number } }>(
          "/api/plaid/exchange",
          {
            method: "POST",
            body: JSON.stringify({
              public_token,
              institution: metadata?.institution ?? null,
            }),
          }
        );
        toast.success(
          `Linked ${metadata?.institution?.name ?? "account"} (synced ${body.sync.added} tx)`
        );
        onLinked?.();
        mutate("/api/items");
        mutate(
          (key) =>
            typeof key === "string" &&
            (key.startsWith("/api/stats/") || key.startsWith("/api/transactions"))
        );
      } catch (err) {
        toast.error(errorMessage("Could not finish linking", err));
      }
    },
    [mutate, onLinked]
  );

  const { open, ready } = usePlaidLink({
    token,
    onSuccess,
    onExit: (err) => {
      if (err) toast.error(`Plaid Link exited (${err.error_code || "unknown"})`);
    },
  });

  useEffect(() => {
    if (token && ready) open();
  }, [token, ready, open]);

  return (
    <button
      onClick={fetchToken}
      disabled={loading}
      className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-slate-950 hover:bg-accent/90 disabled:opacity-50"
    >
      {loading ? "Preparing..." : "Connect a card"}
    </button>
  );
}
