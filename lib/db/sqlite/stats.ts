import type Database from "better-sqlite3";
import type { StatsRange, StatsRepo } from "../../db";
import {
  ALL_BUCKETS,
  NON_SPENDING_BUCKETS,
  type BucketKey,
  type BucketTotals,
  type MonthlyTrendPoint,
} from "../../types";

type SqlParam = string | number;

export function statsRepo(db: Database.Database): StatsRepo {
  return {
    async bucketTotals({ from, to, item_id, include_non_spending }: StatsRange) {
      const where: string[] = ["pending = 0", "date BETWEEN ? AND ?"];
      const params: SqlParam[] = [from, to];
      if (item_id) {
        where.push("item_id = ?");
        params.push(item_id);
      }
      if (!include_non_spending) {
        const placeholders = NON_SPENDING_BUCKETS.map(() => "?").join(",");
        where.push(`bucket NOT IN (${placeholders})`);
        params.push(...NON_SPENDING_BUCKETS);
      }
      const rows = db
        .prepare(
          `SELECT bucket, SUM(amount) AS total FROM transactions WHERE ${where.join(
            " AND "
          )} GROUP BY bucket`
        )
        .all(...params) as Array<{ bucket: BucketKey; total: number }>;
      const out: BucketTotals = {};
      for (const r of rows) out[r.bucket] = r.total;
      return out;
    },

    async monthlyTrend(months, item_id, include_non_spending) {
      const where: string[] = ["pending = 0"];
      const params: SqlParam[] = [];
      if (item_id) {
        where.push("item_id = ?");
        params.push(item_id);
      }
      if (!include_non_spending) {
        const placeholders = NON_SPENDING_BUCKETS.map(() => "?").join(",");
        where.push(`bucket NOT IN (${placeholders})`);
        params.push(...NON_SPENDING_BUCKETS);
      }

      const monthsList: string[] = [];
      const now = new Date();
      for (let i = months - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        monthsList.push(key);
      }
      const earliest = monthsList[0] + "-01";
      where.push("date >= ?");
      params.push(earliest);

      const rows = db
        .prepare(
          `SELECT substr(date, 1, 7) AS month, bucket, SUM(amount) AS total
           FROM transactions
           WHERE ${where.join(" AND ")}
           GROUP BY month, bucket`
        )
        .all(...params) as Array<{ month: string; bucket: BucketKey; total: number }>;

      const byMonth = new Map<string, MonthlyTrendPoint>();
      for (const m of monthsList) {
        byMonth.set(m, { month: m, total: 0, byBucket: {} });
      }
      for (const r of rows) {
        const point = byMonth.get(r.month);
        if (!point) continue;
        point.byBucket[r.bucket] = r.total;
        point.total += r.total;
      }
      // Ensure every bucket key exists for stable chart rendering.
      for (const point of byMonth.values()) {
        for (const b of ALL_BUCKETS) {
          if (point.byBucket[b] === undefined) point.byBucket[b] = 0;
        }
      }
      return monthsList.map((m) => byMonth.get(m)!);
    },
  };
}
