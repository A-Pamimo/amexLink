"use client";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { FieldValue, Gap } from "@/components/FieldValue";
import type { CardView } from "@/lib/cards/view";
import { apiFetch, errorMessage } from "@/lib/client/api";
import { formatDate, formatPercent, formatTimestampToronto } from "@/lib/format";

type UtilReason = NonNullable<CardView["utilization"]["reason"]>;

const UTIL_REASON: Record<UtilReason, string> = {
  missing_current_balance: "Not computed: current balance is missing",
  missing_credit_limit: "Not computed: credit limit is missing",
  credit_limit_not_positive: "Not computed: credit limit is not above zero",
};

const ITEM_STATUS_BADGE: Record<string, string> = {
  needs_relink: "Reconnect needed (Settings)",
  consent_required: "Grant liabilities access (Settings)",
  revoke_failed: "Disconnect incomplete (Settings)",
};

const BALANCE_SOURCE: Record<string, string> = {
  cached: "cached",
  realtime: "live",
};

export function urgencyChip(card: CardView): { text: string; cls: string } {
  switch (card.urgency) {
    case "overdue":
      return { text: "Overdue", cls: "border-rose-400/40 bg-rose-500/20 text-rose-200" };
    case "due_soon": {
      const d = card.days_until_due;
      const text = d === 0 ? "Due today" : `Due in ${d} ${d === 1 ? "day" : "days"}`;
      return { text, cls: "border-amber-400/40 bg-amber-500/20 text-amber-200" };
    }
    case "scheduled": {
      const due = card.fields.next_payment_due_date;
      const date = typeof due.value === "string" ? formatDate(due.value) : "";
      return { text: `Due ${date}`, cls: "border-white/10 bg-white/5 text-slate-200" };
    }
    case "past_not_overdue":
      return {
        text: "Past due date, issuer reports not overdue",
        cls: "border-slate-500/30 bg-slate-500/10 text-slate-300",
      };
    case "unknown":
      return { text: "Due date unavailable", cls: "border-slate-500/30 bg-slate-500/10 text-slate-300" };
  }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

export function CardTile({ card, today }: { card: CardView; today: string }) {
  const [pending, setPending] = useState(false);
  const { mutate } = useSWRConfig();
  const f = card.fields;
  const ccy = card.iso_currency_code;
  const chip = urgencyChip(card);
  const itemBadge = ITEM_STATUS_BADGE[card.item_status];

  const border =
    card.urgency === "overdue"
      ? "border-rose-500/60"
      : card.urgency === "due_soon"
        ? "border-amber-400/50"
        : "border-white/5";

  async function refresh() {
    setPending(true);
    try {
      const body = await apiFetch<{ refresh?: { balance_source?: string } }>(
        `/api/cards/${encodeURIComponent(card.id)}/refresh`,
        { method: "POST" }
      );
      const src = body.refresh?.balance_source;
      toast.success(src === "cached" ? "Live balance unavailable; showing cached balance" : "Balance refreshed");
      await mutate("/api/cards");
    } catch (err) {
      toast.error(errorMessage("Could not refresh balance", err));
    } finally {
      setPending(false);
    }
  }

  const util = card.utilization;
  const synced = card.last_synced_at ? formatTimestampToronto(card.last_synced_at) : "";
  const refreshed = card.last_refreshed_at ? formatTimestampToronto(card.last_refreshed_at) : "";
  const source = card.balance_source ? (BALANCE_SOURCE[card.balance_source] ?? card.balance_source) : null;

  return (
    <article className={`neo-card border p-4 ${border}`} data-urgency={card.urgency}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-50">
            {card.institution_name ?? "Unknown institution"}
          </h3>
          <p className="text-sm text-slate-300">
            {card.name ?? "Card"}
            {card.mask ? <span className="ml-2 font-mono text-slate-400">•••• {card.mask}</span> : null}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${chip.cls}`} data-chip={card.urgency}>
            {chip.text}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-slate-400">
            {ccy ?? "Currency unknown"}
          </span>
        </div>
      </header>

      {itemBadge ? (
        <p className="mt-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
          {itemBadge}
        </p>
      ) : null}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Row label="Current balance">
          <FieldValue obs={f.current_balance} kind="money" currency={ccy} />
        </Row>
        <Row label="Statement balance">
          <FieldValue obs={f.statement_balance} kind="money" currency={ccy} />
        </Row>
        <Row label="Minimum payment">
          <FieldValue obs={f.minimum_payment} kind="money" currency={ccy} />
        </Row>
        <Row label="Next due date">
          <FieldValue obs={f.next_payment_due_date} kind="date" today={today} />
        </Row>
        <Row label="Available credit">
          <FieldValue obs={f.available_credit} kind="money" currency={ccy} />
        </Row>
        <Row label="Credit limit">
          <FieldValue obs={f.credit_limit} kind="money" currency={ccy} />
        </Row>
        <Row label="Utilization (computed)">
          {util.ratio !== null ? (
            <span className="text-sm text-slate-100" title="Computed here: current balance / credit limit">
              {formatPercent(util.ratio)}
            </span>
          ) : (
            <Gap status="utilization" text={util.reason ? UTIL_REASON[util.reason] : "Not computed"} />
          )}
        </Row>
        <Row label="Last payment">
          <div className="space-y-0.5">
            <div>
              <FieldValue obs={f.last_payment_amount} kind="money" currency={ccy} />
            </div>
            <div>
              <FieldValue obs={f.last_payment_date} kind="date" today={today} />
            </div>
          </div>
        </Row>
        <Row label="Overdue flag">
          <FieldValue obs={f.is_overdue} kind="boolean" />
        </Row>
        <div className="col-span-2 sm:col-span-3">
          <dt className="text-[11px] uppercase tracking-wide text-slate-400">APRs</dt>
          <dd className="mt-0.5">
            <FieldValue obs={f.apr} kind="apr" />
          </dd>
        </div>
      </dl>

      <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3">
        <p className="text-[11px] text-slate-400">
          Synced {synced || "never"} · Refreshed {refreshed || "never"} · Balance {source ?? "source unknown"}{" "}
          <span className="text-slate-500">(Toronto time)</span>
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={pending}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10 disabled:opacity-50"
        >
          {pending ? "Refreshing…" : "Refresh balance (billed Plaid call)"}
        </button>
      </footer>
    </article>
  );
}
