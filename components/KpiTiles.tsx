"use client";
import useSWR from "swr";
import { defaultRange, lastMonthRange } from "@/lib/date";
import { currencyCaption, formatCurrency } from "@/lib/format";
import { BUCKET_LABELS, type BucketKey, type BucketTotals } from "@/lib/types";

interface TotalsResponse {
  from: string;
  to: string;
  currencies: string[];
  byCurrency: Record<string, { byBucket: BucketTotals; grandTotal: number }>;
}

function topBucket(byBucket: BucketTotals): { bucket: BucketKey | null; total: number } {
  let best: { bucket: BucketKey | null; total: number } = { bucket: null, total: 0 };
  for (const [k, v] of Object.entries(byBucket)) {
    if ((v ?? 0) > best.total) best = { bucket: k as BucketKey, total: v ?? 0 };
  }
  return best;
}

export function KpiTiles({ itemId, currency }: { itemId?: string; currency?: string }) {
  const range = defaultRange();
  const last = lastMonthRange();
  const itemQs = itemId ? `&item_id=${itemId}` : "";
  const curQs = currency ? `&currency=${currency}` : "";
  // A null key skips the request until a currency has been chosen.
  const { data: thisMonth } = useSWR<TotalsResponse>(
    currency ? `/api/stats/totals?from=${range.from}&to=${range.to}${itemQs}${curQs}` : null
  );
  const { data: lastMonth } = useSWR<TotalsResponse>(
    currency ? `/api/stats/totals?from=${last.from}&to=${last.to}${itemQs}${curQs}` : null
  );

  const cur = currency ?? null;
  const thisTotals = currency ? thisMonth?.byCurrency[currency] : undefined;
  const lastTotals = currency ? lastMonth?.byCurrency[currency] : undefined;
  const total = thisTotals?.grandTotal ?? 0;
  const prev = lastTotals?.grandTotal ?? 0;
  const diff = total - prev;
  const pct = prev > 0 ? Math.round((diff / prev) * 100) : null;
  const top = topBucket(thisTotals?.byBucket ?? {});
  const txCount = Object.values(thisTotals?.byBucket ?? {}).filter((v) => (v ?? 0) > 0).length;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="This month" value={formatCurrency(total, cur)} sub={currencyCaption(currency)} />
      <Tile
        label="vs last month"
        value={
          pct === null ? "—" : `${pct >= 0 ? "+" : ""}${pct}%`
        }
        sub={prev > 0 ? formatCurrency(diff, cur) : "no prior month"}
        tone={pct === null ? "neutral" : pct <= 0 ? "good" : "bad"}
      />
      <Tile
        label="Top bucket"
        value={top.bucket ? BUCKET_LABELS[top.bucket] : "—"}
        sub={top.bucket ? formatCurrency(top.total, cur) : ""}
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
