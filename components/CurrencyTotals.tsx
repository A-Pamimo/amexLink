import type { ReactNode } from "react";
import type { CurrencyTotals as Totals } from "@/lib/cards/view";
import { sortCurrencies } from "@/lib/currency";
import { currencyCaption, formatCurrency, formatPercent } from "@/lib/format";

function Tile({ label, caption, children }: { label: string; caption?: string; children: ReactNode }) {
  return (
    <div className="neo-card p-4">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-100">{children}</div>
      {caption ? <div className="mt-0.5 text-xs text-slate-400">{caption}</div> : null}
    </div>
  );
}

const NONE = <span className="text-sm font-normal italic text-slate-500">No card reports this</span>;

/**
 * One group of tiles per currency. Amounts of different currencies are never added together:
 * there is no cross-currency figure anywhere in this component.
 */
export function CurrencyTotals({ totals }: { totals: Record<string, Totals> }) {
  const codes = sortCurrencies(Object.keys(totals));
  if (codes.length === 0) return null;
  return (
    <div className="space-y-4">
      {codes.map((code) => {
        const t = totals[code];
        const u = t.utilization;
        const unknown = currencyCaption(code);
        const fmt = (n: number) => formatCurrency(n, code);
        return (
          <section key={code} aria-label={`${code} totals`} data-currency={code}>
            <h2 className="mb-2 text-sm font-medium text-slate-300">
              {unknown ? "Currency unknown" : code}
              {unknown ? <span className="ml-2 text-xs text-slate-500">(provider gave no currency code)</span> : null}
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Tile label="Total balance" caption={unknown}>
                {t.balance !== null ? fmt(t.balance) : NONE}
              </Tile>
              <Tile label="Due this cycle" caption="sum of statement balances">
                {t.statement_due !== null ? fmt(t.statement_due) : NONE}
              </Tile>
              <Tile
                label="Overall utilization"
                caption={`computed from ${u.included} ${u.included === 1 ? "card" : "cards"}; ${u.excluded} excluded (missing limit or balance)`}
              >
                {u.ratio !== null ? formatPercent(u.ratio) : NONE}
              </Tile>
            </div>
          </section>
        );
      })}
    </div>
  );
}
