"use client";
import useSWR from "swr";
import { defaultRange } from "@/lib/date";
import { formatCurrency } from "@/lib/format";
import { BUCKET_LABELS, type BucketKey, type BucketTotals } from "@/lib/types";

interface TotalsResponse {
  from: string;
  to: string;
  byBucket: BucketTotals;
  grandTotal: number;
}

function topBucket(byBucket: BucketTotals): { bucket: BucketKey | null; total: number } {
  let best: { bucket: BucketKey | null; total: number } = { bucket: null, total: 0 };
  for (const [k, v] of Object.entries(byBucket)) {
    if ((v ?? 0) > best.total) best = { bucket: k as BucketKey, total: v ?? 0 };
  }
  return best;
}

function lastMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  const f = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: f(start), to: f(end) };
}

export function KpiTiles({ itemId }: { itemId?: string }) {
  const range = defaultRange();
  const last = lastMonthRange();
  const itemQs = itemId ? `&item_id=${itemId}` : "";
  const { data: thisMonth } = useSWR<TotalsResponse>(
    `/api/stats/totals?from=${range.from}&to=${range.to}${itemQs}`
  );
  const { data: lastMonth } = useSWR<TotalsResponse>(
    `/api/stats/totals?from=${last.from}&to=${last.to}${itemQs}`
  );

  const total = thisMonth?.grandTotal ?? 0;
  const prev = lastMonth?.grandTotal ?? 0;
  const diff = total - prev;
  const pct = prev > 0 ? Math.round((diff / prev) * 100) : null;
  const top = topBucket(thisMonth?.byBucket ?? {});
  const txCount = Object.values(thisMonth?.byBucket ?? {}).filter((v) => (v ?? 0) > 0).length;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="This month" value={formatCurrency(total)} />
      <Tile
        label="vs last month"
        value={
          pct === null ? "—" : `${pct >= 0 ? "+" : ""}${pct}%`
        }
        sub={prev > 0 ? formatCurrency(diff) : "no prior month"}
        tone={pct === null ? "neutral" : pct <= 0 ? "good" : "bad"}
      />
      <Tile
        label="Top bucket"
        value={top.bucket ? BUCKET_LABELS[top.bucket] : "—"}
        sub={top.bucket ? formatCurrency(top.total) : ""}
      />
      <Tile label="Active buckets" value={String(txCount)} />
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "good" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-400"
      : tone === "bad"
        ? "text-rose-400"
        : "text-slate-100";
  return (
    <div className="neo-card p-4">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-slate-400">{sub}</div> : null}
    </div>
  );
}
