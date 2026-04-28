"use client";
import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { toast } from "sonner";
import { useSWRConfig } from "swr";

export function PlaidLinkButton({ onLinked }: { onLinked?: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { mutate } = useSWRConfig();

  const fetchToken = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/plaid/link-token", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.error_message ?? "link_token failed");
      setToken(body.link_token);
    } catch (err: any) {
      toast.error(err?.message ?? "Could not start Plaid Link");
    } finally {
      setLoading(false);
    }
  }, []);

  const onSuccess = useCallback(
    async (public_token: string, metadata: any) => {
      try {
        const res = await fetch("/api/plaid/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            public_token,
            institution: metadata?.institution ?? null,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error?.error_message ?? "exchange failed");
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
      } catch (err: any) {
        toast.error(err?.message ?? "Could not finish linking");
      }
    },
    [mutate, onLinked]
  );

  const { open, ready } = usePlaidLink({
    token,
    onSuccess,
    onExit: (err) => {
      if (err) toast.error(err.error_message ?? err.display_message ?? "Plaid exited");
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
