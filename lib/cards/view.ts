import "server-only";
import { getDB } from "../db";
import { mergeCards, type MergedCard } from "./merge";
import { compareCards, daysUntilDue, dueUrgency, torontoToday, type Urgency } from "./urgency";

export interface CardView extends MergedCard {
  urgency: Urgency;
  days_until_due: number | null;
}

export interface CurrencyTotals {
  /** Sum of present current balances; null when no card has one. */
  balance: number | null;
  /** Sum of present statement balances ("due this cycle"); null when no card has one. */
  statement_due: number | null;
  utilization: {
    /** sum(current_balance) / sum(credit_limit) over included cards; null when none included. */
    ratio: number | null;
    /** Cards with both a present balance and a limit > 0. */
    included: number;
    /** Cards of this currency left out because one of the two is missing. */
    excluded: number;
  };
}

export interface CardsResponse {
  cards: CardView[];
  /** Keyed by ISO currency code. Totals are NEVER summed across currencies. */
  totals_by_currency: Record<string, CurrencyTotals>;
  counts: { overdue: number; due_soon: number };
  /** America/Toronto civil date used for urgency. */
  today: string;
  generated_at: string;
}

const UNKNOWN_CURRENCY = "UNKNOWN";

const cents = (n: number) => Math.round(n * 100) / 100;

function numberIfPresent(o: { status: string; value: unknown }): number | null {
  return o.status === "present" && typeof o.value === "number" ? o.value : null;
}

export function totalsByCurrency(cards: MergedCard[]): Record<string, CurrencyTotals> {
  interface Acc {
    balance: number;
    balanceN: number;
    due: number;
    dueN: number;
    utilBalance: number;
    utilLimit: number;
    included: number;
    excluded: number;
  }
  const acc = new Map<string, Acc>();
  for (const c of cards) {
    const ccy = c.iso_currency_code ?? UNKNOWN_CURRENCY;
    const a =
      acc.get(ccy) ??
      { balance: 0, balanceN: 0, due: 0, dueN: 0, utilBalance: 0, utilLimit: 0, included: 0, excluded: 0 };
    const bal = numberIfPresent(c.fields.current_balance);
    const lim = numberIfPresent(c.fields.credit_limit);
    const due = numberIfPresent(c.fields.statement_balance);
    if (bal !== null) {
      a.balance += bal;
      a.balanceN++;
    }
    if (due !== null) {
      a.due += due;
      a.dueN++;
    }
    if (bal !== null && lim !== null && lim > 0) {
      a.utilBalance += bal;
      a.utilLimit += lim;
      a.included++;
    } else {
      a.excluded++;
    }
    acc.set(ccy, a);
  }

  const out: Record<string, CurrencyTotals> = {};
  for (const [ccy, a] of [...acc.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    out[ccy] = {
      balance: a.balanceN > 0 ? cents(a.balance) : null,
      statement_due: a.dueN > 0 ? cents(a.due) : null,
      utilization: {
        ratio: a.included > 0 && a.utilLimit > 0 ? a.utilBalance / a.utilLimit : null,
        included: a.included,
        excluded: a.excluded,
      },
    };
  }
  return out;
}

/** Pure part of the view: merged cards + now -> response. */
export function buildCardsResponse(merged: MergedCard[], now: Date = new Date()): CardsResponse {
  const today = torontoToday(now);
  const cards: CardView[] = merged
    .map((c) => ({ ...c, urgency: dueUrgency(c, today), days_until_due: daysUntilDue(c, today) }))
    .sort(compareCards);
  return {
    cards,
    totals_by_currency: totalsByCurrency(merged),
    counts: {
      overdue: cards.filter((c) => c.urgency === "overdue").length,
      due_soon: cards.filter((c) => c.urgency === "due_soon").length,
    },
    today,
    generated_at: now.toISOString(),
  };
}

export async function getCardsResponse(now: Date = new Date()): Promise<CardsResponse> {
  const db = await getDB();
  return buildCardsResponse(mergeCards(await db.listCardRows()), now);
}
