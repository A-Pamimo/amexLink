"use client";
import { useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { apiFetch, errorMessage } from "@/lib/client/api";

export function SyncButton({ itemId }: { itemId?: string }) {
  const [busy, setBusy] = useState(false);
  const { mutate } = useSWRConfig();

  async function run() {
    setBusy(true);
    try {
      const url = itemId
        ? `/api/plaid/sync?item_id=${encodeURIComponent(itemId)}`
        : "/api/plaid/sync";
      const body = await apiFetch<{ added: number; modified: number; removed: number }>(
        url,
        { method: "POST" }
      );
      toast.success(
        `Synced — +${body.added} added, ${body.modified} modified, ${body.removed} removed`
      );
      mutate(
        (k) =>
          typeof k === "string" &&
          (k.startsWith("/api/stats/") ||
            k.startsWith("/api/transactions") ||
            k === "/api/items" ||
            k === "/api/health")
      );
    } catch (err) {
      toast.error(errorMessage("Sync failed", err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={run}
      disabled={busy}
      className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10 disabled:opacity-50"
    >
      {busy ? "Syncing…" : itemId ? "Sync this card" : "Sync all"}
    </button>
  );
}
