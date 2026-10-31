"use client";
import { useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { apiFetch, errorMessage } from "@/lib/client/api";
import type { SyncAllResult } from "@/lib/types";

export function SyncButton({ itemId }: { itemId?: string }) {
  const [busy, setBusy] = useState(false);
  const { mutate } = useSWRConfig();

  async function run() {
    setBusy(true);
    try {
      const url = itemId
        ? `/api/plaid/sync?item_id=${encodeURIComponent(itemId)}`
        : "/api/plaid/sync";
      const body = await apiFetch<SyncAllResult>(url, { method: "POST" });
      const { totals } = body;
      const failed = body.items.filter((i) => !i.ok);
      const ok = body.items.length - failed.length;

      if (ok > 0 || failed.length === 0) {
        toast.success(
          `Synced ${ok} ${ok === 1 ? "card" : "cards"}: +${totals.added} added, ${totals.modified} modified, ${totals.removed} removed`
        );
      }
      if (failed.length > 0) {
        const codes = Array.from(new Set(failed.map((i) => i.error_code ?? "sync_failed")));
        toast.error(
          `${failed.length} ${failed.length === 1 ? "card" : "cards"} failed to sync (${codes.join(", ")})`
        );
      }
      mutate(
        (k) =>
          typeof k === "string" &&
          (k.startsWith("/api/stats/") ||
            k.startsWith("/api/transactions") ||
            k === "/api/items" ||
            k === "/api/cards" ||
            k === "/api/system")
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
