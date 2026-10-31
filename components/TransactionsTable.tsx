"use client";
import useSWR, { useSWRConfig } from "swr";
import { useState } from "react";
import { toast } from "sonner";
import { BucketSelect } from "./BucketSelect";
import { apiFetch, errorMessage } from "@/lib/client/api";
import { formatCurrency, formatDate } from "@/lib/format";
import { BUCKET_LABELS, type BucketKey, type Transaction } from "@/lib/types";

interface TxResponse {
  transactions: Transaction[];
}

export function TransactionsTable({
  itemId,
  includeNonSpending,
  search,
}: {
  itemId?: string;
  includeNonSpending?: boolean;
  search?: string;
}) {
  const params = new URLSearchParams();
  if (itemId) params.set("item_id", itemId);
  if (includeNonSpending) params.set("include_non_spending", "1");
  if (search) params.set("q", search);
  params.set("limit", "200");
  const key = `/api/transactions?${params.toString()}`;

  const { data, isLoading } = useSWR<TxResponse>(key);
  const { mutate } = useSWRConfig();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function changeBucket(tx: Transaction, bucket: BucketKey) {
    setBusyId(tx.id);
    const optimistic = (current: TxResponse | undefined): TxResponse => ({
      transactions:
        current?.transactions.map((t) =>
          t.id === tx.id ? { ...t, bucket, bucket_override: 1 } : t
        ) ?? [],
    });
    mutate(key, optimistic, { revalidate: false });
    try {
      await apiFetch(`/api/transactions/${tx.id}`, {
        method: "PATCH",
        body: JSON.stringify({ bucket }),
      });
      toast.success(`Moved to ${BUCKET_LABELS[bucket]}`);
      mutate(
        (k) => typeof k === "string" && k.startsWith("/api/stats/")
      );
    } catch (err) {
      toast.error(errorMessage("Could not update", err));
      mutate(key);
    } finally {
      setBusyId(null);
    }
  }

  async function resetAuto(tx: Transaction) {
    setBusyId(tx.id);
    try {
      await apiFetch(`/api/transactions/${tx.id}`, { method: "DELETE" });
      toast.success("Reset to auto-categorized");
      mutate(key);
      mutate((k) => typeof k === "string" && k.startsWith("/api/stats/"));
    } catch (err) {
      toast.error(errorMessage("Could not reset", err));
    } finally {
      setBusyId(null);
    }
  }

  if (isLoading) {
    return <div className="neo-card p-6 text-sm text-slate-400">Loading transactions…</div>;
  }
  const txs = data?.transactions ?? [];
  if (txs.length === 0) {
    return (
      <div className="neo-card p-6 text-sm text-slate-400">
        No transactions match these filters.
      </div>
    );
  }

  return (
    <div className="neo-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-white/5 text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-4 py-2 text-left">Date</th>
            <th className="px-4 py-2 text-left">Merchant</th>
            <th className="px-4 py-2 text-left">Bucket</th>
            <th className="px-4 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {txs.map((tx) => (
            <tr key={tx.id} className="border-t border-white/5 hover:bg-white/[0.03]">
              <td className="whitespace-nowrap px-4 py-2 text-slate-300">
                {formatDate(tx.date)}
                {tx.pending ? (
                  <span className="ml-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                    pending
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-2">
                <div className="font-medium text-slate-100">
                  {tx.merchant_name ?? tx.name}
                </div>
                {tx.merchant_name && tx.name !== tx.merchant_name ? (
                  <div className="text-xs text-slate-500">{tx.name}</div>
                ) : null}
              </td>
              <td className="px-4 py-2">
                <div className="flex items-center gap-2">
                  <BucketSelect
                    value={tx.bucket}
                    onChange={(b) => changeBucket(tx, b)}
                  />
                  {tx.bucket_override ? (
                    <button
                      onClick={() => resetAuto(tx)}
                      disabled={busyId === tx.id}
                      className="text-[10px] uppercase tracking-wide text-slate-400 hover:text-accent disabled:opacity-50"
                      title="Clear override and recompute"
                    >
                      reset
                    </button>
                  ) : null}
                </div>
              </td>
              <td
                className={
                  "px-4 py-2 text-right tabular-nums " +
                  (tx.amount < 0 ? "text-emerald-400" : "text-slate-100")
                }
              >
                {formatCurrency(tx.amount, tx.iso_currency_code)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
