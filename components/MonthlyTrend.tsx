"use client";
import useSWR from "swr";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/format";
import {
  ALL_BUCKETS,
  BUCKET_COLORS,
  BUCKET_LABELS,
  NON_SPENDING_BUCKETS,
  type BucketKey,
  type MonthlyTrendPoint,
} from "@/lib/types";

interface TrendResponse {
  months: number;
  trend: MonthlyTrendPoint[];
}

export function MonthlyTrend({
  months = 6,
  itemId,
  includeNonSpending,
}: {
  months?: number;
  itemId?: string;
  includeNonSpending?: boolean;
}) {
  const itemQs = itemId ? `&item_id=${itemId}` : "";
  const incQs = includeNonSpending ? `&include_non_spending=1` : "";
  const { data, isLoading } = useSWR<TrendResponse>(
    `/api/stats/trend?months=${months}${itemQs}${incQs}`
  );

  const buckets: BucketKey[] = includeNonSpending
    ? ALL_BUCKETS
    : ALL_BUCKETS.filter((b) => !NON_SPENDING_BUCKETS.includes(b));

  const chartData =
    data?.trend.map((p) => ({
      month: p.month,
      ...p.byBucket,
    })) ?? [];

  return (
    <div className="neo-card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-slate-200">
          Monthly trend — last {months} months
        </h3>
      </div>
      <div className="h-72">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            Loading…
          </div>
        ) : chartData.every((p) =>
            buckets.every((b) => !((p as any)[b] > 0))
          ) ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            No spending recorded yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barSize={28}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="month" stroke="#94a3b8" fontSize={12} />
              <YAxis
                stroke="#94a3b8"
                fontSize={12}
                tickFormatter={(v) => formatCurrency(v).replace(/\.\d+/, "")}
              />
              <Tooltip
                contentStyle={{
                  background: "#0b1020",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  color: "#e2e8f0",
                }}
                formatter={(value: number, name) => [
                  formatCurrency(value),
                  BUCKET_LABELS[name as BucketKey] ?? name,
                ]}
              />
              <Legend
                formatter={(v) => BUCKET_LABELS[v as BucketKey] ?? v}
                wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }}
              />
              {buckets.map((b) => (
                <Bar
                  key={b}
                  dataKey={b}
                  stackId="a"
                  fill={BUCKET_COLORS[b]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
