"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";
import { ApiError, apiFetch, errorMessage, type ItemResult } from "@/lib/client/api";

const CONFIRM_WORD = "DELETE";

/**
 * "Delete all local data": revokes every Plaid connection, then wipes cards, transactions and
 * settings from the local database. Typed confirmation. The audit log is kept. Plaid keeps its
 * own copy under its own policy; this never claims otherwise.
 */
export function DangerZone() {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const { data: itemsData } = useSWR<{ items: { item_id: string; institution_name: string | null }[] }>(
    "/api/items"
  );
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  // Labels are resolved when the request fails: revoked items disappear from /api/items afterwards.
  const [failure, setFailure] = useState<{
    code: string;
    results: (ItemResult & { label: string })[];
  } | null>(null);

  async function run() {
    setBusy(true);
    setFailure(null);
    try {
      const body = await apiFetch<{ ok: true; results: ItemResult[] }>("/api/data", { method: "DELETE" });
      const n = body.results?.length ?? 0;
      toast.success(`All local data deleted (${n} Plaid ${n === 1 ? "connection" : "connections"} revoked)`);
      setTyped("");
      await mutate(() => true, undefined, { revalidate: false });
      router.push("/");
    } catch (err) {
      if (err instanceof ApiError && err.code === "revoke_incomplete") {
        const names = new Map((itemsData?.items ?? []).map((i) => [i.item_id, i.institution_name]));
        setFailure({
          code: err.code,
          results: (err.results ?? []).map((r) => ({
            ...r,
            label: names.get(r.item_id) ?? "Unknown institution",
          })),
        });
      }
      toast.error(errorMessage("Could not delete local data", err));
      await mutate("/api/items");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2" aria-labelledby="danger-heading">
      <h2 id="danger-heading" className="text-sm font-medium text-rose-300">
        Danger zone
      </h2>
      <div className="neo-card space-y-3 border border-rose-500/30 p-4 text-sm">
        <p className="text-slate-300">
          <strong>Delete all local data</strong> revokes every Plaid connection first, then erases all
          cards, balances, transactions and settings from this machine. The security audit log is kept.
          Plaid retains data under its own policy. If any connection cannot be revoked, nothing further is
          deleted and you can retry.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="delete-confirm" className="text-xs text-slate-400">
            Type {CONFIRM_WORD} to confirm
          </label>
          <input
            id="delete-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-32 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={run}
            disabled={busy || typed !== CONFIRM_WORD}
            className="rounded-md border border-rose-400/30 bg-rose-500/20 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-500/30 disabled:opacity-40"
          >
            {busy ? "Deleting…" : "Delete all local data"}
          </button>
        </div>

        {failure ? (
          <div role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3">
            <p className="text-rose-200">
              Some connections could not be revoked at Plaid ({failure.code}). Nothing else was deleted.
              Fix the problem and run it again.
            </p>
            {failure.results.length > 0 ? (
              <ul className="mt-2 space-y-0.5 text-xs">
                {failure.results.map((r) => (
                  <li key={r.item_id} className={r.ok ? "text-emerald-300" : "text-rose-300"}>
                    {r.label}: {r.ok ? "revoked and removed" : `not revoked${r.code ? ` (${r.code})` : ""}`}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
