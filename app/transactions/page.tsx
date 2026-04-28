"use client";
import { useState } from "react";
import { IncomeToggle } from "@/components/IncomeToggle";
import { ItemFilter } from "@/components/ItemFilter";
import { TransactionsTable } from "@/components/TransactionsTable";

export default function TransactionsPage() {
  const [itemId, setItemId] = useState<string | undefined>();
  const [includeNonSpending, setIncludeNonSpending] = useState(true);
  const [search, setSearch] = useState("");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Transactions</h1>
        <div className="flex items-center gap-3">
          <input
            type="search"
            placeholder="Search merchant or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm placeholder:text-slate-500 focus:border-accent/60 focus:outline-none"
          />
          <IncomeToggle value={includeNonSpending} onChange={setIncludeNonSpending} />
          <ItemFilter value={itemId} onChange={setItemId} />
        </div>
      </div>
      <TransactionsTable
        itemId={itemId}
        includeNonSpending={includeNonSpending}
        search={search.trim() || undefined}
      />
    </div>
  );
}
