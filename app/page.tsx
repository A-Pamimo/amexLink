"use client";
import useSWR from "swr";
import { CardTile } from "@/components/CardTile";
import { CurrencyTotals } from "@/components/CurrencyTotals";
import { PlaidLinkButton } from "@/components/PlaidLinkButton";
import { SyncButton } from "@/components/SyncButton";
import { UrgencyBanner } from "@/components/UrgencyBanner";
import type { CardsResponse } from "@/lib/cards/view";
import { errorMessage } from "@/lib/client/api";
import type { PlaidItem } from "@/lib/types";

// Read-only overview. Everything shown comes from GET /api/cards (provider data, derived at read
// time); there is no form, input or override anywhere on this page by design.
export default function CardsOverviewPage() {
  const { data, error, isLoading } = useSWR<CardsResponse>("/api/cards");
  const { data: itemsData } = useSWR<{ items: Omit<PlaidItem, "access_token">[] }>("/api/items");

  if (error) {
    return (
      <div className="neo-card mx-auto mt-12 max-w-xl p-6 text-sm text-rose-300" role="alert">
        {errorMessage("Could not load your cards", error)}
      </div>
    );
  }
  if (isLoading || !data) {
    return <div className="neo-card p-6 text-sm text-slate-400">Loading cards…</div>;
  }

  const itemCount = itemsData?.items.length;
  if (data.cards.length === 0 && itemCount === 0) {
    return (
      <div className="neo-card mx-auto mt-12 max-w-xl p-8 text-center">
        <h1 className="mb-2 text-2xl font-semibold">Welcome to AmexLens</h1>
        <p className="mb-6 text-sm text-slate-400">
          Connect a credit card through Plaid to see every balance, limit, minimum payment, due date and
          APR on one screen. Values come only from Plaid; nothing is typed in by hand.
        </p>
        <div className="flex justify-center">
          <PlaidLinkButton />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Cards</h1>
        <SyncButton />
      </div>

      <UrgencyBanner counts={data.counts} today={data.today} generatedAt={data.generated_at} />

      <CurrencyTotals totals={data.totals_by_currency} />

      {data.cards.length === 0 ? (
        <div className="neo-card p-6 text-sm text-slate-400">
          Your connected institutions have not returned any credit cards yet. Use <em>Sync all</em>, or
          check the item status in Settings.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.cards.map((card) => (
            <CardTile key={card.id} card={card} today={data.today} />
          ))}
        </div>
      )}
    </div>
  );
}
