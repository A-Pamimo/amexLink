"use client";
import useSWR from "swr";
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { defaultRange } from "@/lib/date";
import { formatCurrency } from "@/lib/format";
import { BUCKET_COLORS, BUCKET_LABELS, type BucketKey, type BucketTotals } from "@/lib/types";

interface TotalsResponse {
  from: string;
  to: string;
  byBucket: BucketTotals;
  grandTotal: number;
}

export function BucketDonut({
  itemId,
  includeNonSpending,
}: {
  itemId?: string;
  includeNonSpending?: boolean;
}) {
  const range = defaultRange();
  const itemQs = itemId ? `&item_id=${itemId}` : "";
  const incQs = includeNonSpending ? `&include_non_spending=1` : "";
  const { data, isLoading } = useSWR<TotalsResponse>(
    `/api/stats/totals?from=${range.from}&to=${range.to}${itemQs}${incQs}`
  );

  const entries = Object.entries(data?.byBucket ?? {})
    .map(([k, v]) => ({ bucket: k as BucketKey, value: v ?? 0 }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  return (
    <div className="neo-card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-slate-200">By bucket — this month</h3>
        <span className="text-xs text-slate-400">{formatCurrency(data?.grandTotal ?? 0)}</span>
      </div>
      <div className="h-64">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            No transactions in range.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={entries}
                dataKey="value"
                nameKey="bucket"
                innerRadius={60}
                outerRadius={90}
                paddingAngle={2}
              >
                {entries.map((e) => (
                  <Cell key={e.bucket} fill={BUCKET_COLORS[e.bucket]} stroke="none" />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: "#0b1020",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  color: "#e2e8f0",
                }}
                formatter={(value: number, _name, item) => [
                  formatCurrency(value),
                  BUCKET_LABELS[(item?.payload?.bucket ?? "other") as BucketKey],
                ]}
              />
              <Legend
                formatter={(v) => BUCKET_LABELS[v as BucketKey] ?? v}
                wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
