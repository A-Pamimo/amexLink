import type Database from "better-sqlite3";
import type { StatsRange, StatsRepo } from "../../db";
import { sortCurrencies } from "../../currency";
import { torontoMonthWindow } from "../../date";
import {
  ALL_BUCKETS,
  NON_SPENDING_BUCKETS,
  type BucketKey,
  type BucketTotals,
  type MonthlyTrendPoint,
} from "../../types";

type SqlParam = string | number;

/** Currency key used by every grouping: a missing or empty ISO code becomes `UNKNOWN`. */
const CUR = "COALESCE(NULLIF(iso_currency_code, ''), 'UNKNOWN')";

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
          `SELECT ${CUR} AS currency, bucket, SUM(amount) AS total
           FROM transactions
           WHERE ${where.join(" AND ")}
           GROUP BY currency, bucket`
        )
        .all(...params) as Array<{ currency: string; bucket: BucketKey; total: number }>;

      const byCurrency: Record<string, BucketTotals> = {};
      for (const r of rows) (byCurrency[r.currency] ??= {})[r.bucket] = r.total;
      return { byCurrency, currencies: sortCurrencies(Object.keys(byCurrency)) };
    },

    async monthlyTrend(months, item_id, include_non_spending, currency, now = new Date()) {
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

      // The window is Toronto's current month backwards. Rows are grouped by their own
      // `date` column (a civil date already), never converted through a time zone.
      const monthsList = torontoMonthWindow(months, now);
      where.push("date >= ?");
      params.push(monthsList[0] + "-01");

      const rows = db
        .prepare(
          `SELECT substr(date, 1, 7) AS month, ${CUR} AS currency, bucket, SUM(amount) AS total
           FROM transactions
           WHERE ${where.join(" AND ")}
           GROUP BY month, currency, bucket`
        )
        .all(...params) as Array<{
        month: string;
        currency: string;
        bucket: BucketKey;
        total: number;
      }>;

      const seen = new Set(rows.map((r) => r.currency));
      const currencies = sortCurrencies(seen);
      const wanted = currency ? [currency] : currencies;

      const series = new Map<string, Map<string, MonthlyTrendPoint>>();
      for (const c of wanted) {
        const byMonth = new Map<string, MonthlyTrendPoint>();
        for (const m of monthsList) byMonth.set(m, { month: m, total: 0, byBucket: {} });
        series.set(c, byMonth);
      }
      for (const r of rows) {
        const point = series.get(r.currency)?.get(r.month);
        if (!point) continue;
        point.byBucket[r.bucket] = r.total;
        point.total += r.total;
      }

      const byCurrency: Record<string, MonthlyTrendPoint[]> = {};
      for (const [c, byMonth] of series) {
        // Ensure every bucket key exists for stable chart rendering.
        for (const point of byMonth.values()) {
          for (const b of ALL_BUCKETS) {
            if (point.byBucket[b] === undefined) point.byBucket[b] = 0;
          }
        }
        byCurrency[c] = monthsList.map((m) => byMonth.get(m)!);
      }
      return { byCurrency, currencies };
    },

    async listCurrencies() {
      const rows = db
        .prepare(`SELECT DISTINCT ${CUR} AS currency FROM transactions`)
        .all() as Array<{ currency: string }>;
      return sortCurrencies(rows.map((r) => r.currency));
    },
  };
}
