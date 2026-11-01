"use client";
import useSWR from "swr";
import { useState } from "react";
import { BucketDonut } from "@/components/BucketDonut";
import { CurrencySelect } from "@/components/CurrencySelect";
import { IncomeToggle } from "@/components/IncomeToggle";
import { ItemFilter } from "@/components/ItemFilter";
import { KpiTiles } from "@/components/KpiTiles";
import { MonthlyTrend } from "@/components/MonthlyTrend";
import { PlaidLinkButton } from "@/components/PlaidLinkButton";
import { SyncButton } from "@/components/SyncButton";
import { TransactionsTable } from "@/components/TransactionsTable";
import type { PlaidItem } from "@/lib/types";

export default function DashboardPage() {
  const [itemId, setItemId] = useState<string | undefined>(undefined);
  const [includeNonSpending, setIncludeNonSpending] = useState(false);
  const [currency, setCurrency] = useState<string | undefined>(undefined);
  const { data: itemsData } = useSWR<{ items: Omit<PlaidItem, "access_token">[] }>(
    "/api/items"
  );
  const itemCount = itemsData?.items.length ?? 0;

  if (itemCount === 0) {
    return (
      <div className="neo-card mx-auto mt-12 max-w-xl p-8 text-center">
        <h1 className="mb-2 text-2xl font-semibold">Welcome to AmexLens</h1>
        <p className="mb-6 text-sm text-slate-400">
          Connect a card via Plaid to start seeing your spending broken down by
          bucket, with a monthly trend and a per-transaction view.
        </p>
        <div className="flex justify-center">
          <PlaidLinkButton />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <div className="flex items-center gap-3">
          <IncomeToggle value={includeNonSpending} onChange={setIncludeNonSpending} />
          <CurrencySelect value={currency} onChange={setCurrency} />
          <ItemFilter value={itemId} onChange={setItemId} />
          <SyncButton itemId={itemId} />
        </div>
      </div>

      <KpiTiles itemId={itemId} currency={currency} />

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <BucketDonut
            itemId={itemId}
            includeNonSpending={includeNonSpending}
            currency={currency}
          />
        </div>
        <div className="lg:col-span-3">
          <MonthlyTrend
            months={6}
            itemId={itemId}
            includeNonSpending={includeNonSpending}
            currency={currency}
          />
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-slate-300">Recent transactions</h2>
        <TransactionsTable itemId={itemId} includeNonSpending={includeNonSpending} />
      </div>
    </div>
  );
}
