// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CardTile } from "@/components/CardTile";
import { CurrencyTotals } from "@/components/CurrencyTotals";
import { UrgencyBanner } from "@/components/UrgencyBanner";
import { mergeCards } from "@/lib/cards/merge";
import { buildCardsResponse } from "@/lib/cards/view";
import type { FieldKey, FieldObservation } from "@/lib/providers/types";
import { makeRow, ob, present } from "../helpers/cards";

afterEach(() => cleanup());

// 2026-10-31T16:00Z is 12:00 in Toronto: today is 2026-10-31.
const NOW = new Date("2026-10-31T16:00:00.000Z");

function build(rows: Array<Parameters<typeof makeRow>[0]>) {
  return buildCardsResponse(mergeCards(rows.map((r, i) => makeRow({ id: `acc-${i}`, provider_account_id: `pa-${i}`, mask: String(1000 + i), ...r }))), NOW);
}

const fields = (f: Partial<Record<FieldKey, FieldObservation>>) => f;

describe("CardTile", () => {
  const overdue = build([
    {
      fields: fields({
        current_balance: present(1500.25),
        credit_limit: present(5000),
        statement_balance: present(1200),
        minimum_payment: present(35),
        next_payment_due_date: present("2026-10-20"),
        is_overdue: present(true),
        available_credit: ob("not_supported"),
        last_payment_amount: present(200),
        last_payment_date: present("2026-10-01"),
        apr: present([{ apr_type: "penalty_apr", apr_percentage: 29.99, balance_subject_to_apr: null, interest_charge_amount: null }]),
      }),
    },
  ]);

  it("an overdue card shows the red chip, the gap reason, computed utilization and the billed refresh button", () => {
    const card = overdue.cards[0];
    expect(card.urgency).toBe("overdue");
    const { container } = render(<CardTile card={card} today={overdue.today} />);

    const chip = container.querySelector('[data-chip="overdue"]');
    expect(chip?.textContent).toBe("Overdue");
    expect(chip?.className).toContain("rose");

    expect(screen.getByText(/American Express Canada/)).toBeTruthy();
    expect(container.textContent).toContain("•••• 1000");
    expect(container.textContent).toMatch(/1,500\.25/);
    expect(screen.getByText("Plaid does not support this field at this institution")).toBeTruthy();
    expect(container.textContent).toContain("30%"); // 1500.25 / 5000, computed
    expect(container.textContent).toContain("Utilization (computed)");
    expect(container.textContent).toContain("Penalty 29.99%");
    expect(container.textContent).toContain("2026-10-20 (11 days ago)");

    const btn = screen.getByRole("button", { name: /Refresh balance/ });
    expect(btn.textContent).toContain("billed");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    // The only control on the tile is the refresh button: nothing editable.
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("input, textarea, select")).toBeNull();
  });

  it("shows when it was synced and whether the balance is cached or live", () => {
    const { container } = render(<CardTile card={overdue.cards[0]} today={overdue.today} />);
    expect(container.textContent).toContain("Synced 2026-10-31 08:00");
    expect(container.textContent).toContain("Balance cached");
    cleanup();
    const live = build([{ balance_source: "realtime", fields: {} }]);
    const r = render(<CardTile card={live.cards[0]} today={live.today} />);
    expect(r.container.textContent).toContain("Balance live");
  });

  it("urgency chips and item status badges", () => {
    const view = build([
      { fields: fields({ next_payment_due_date: present("2026-10-31"), is_overdue: present(false) }) },
      { fields: fields({ next_payment_due_date: present("2026-11-03"), is_overdue: present(false) }), item_status: "needs_relink" },
      { fields: fields({ next_payment_due_date: present("2026-12-15"), is_overdue: present(false) }), item_status: "consent_required" },
      { fields: fields({ next_payment_due_date: present("2026-10-01"), is_overdue: present(false) }), item_status: "revoke_failed" },
      { fields: {} },
    ]);
    const texts = view.cards.map((c) => {
      const { container } = render(<CardTile card={c} today={view.today} />);
      const out = { chip: container.querySelector("[data-chip]")?.textContent, text: container.textContent ?? "" };
      cleanup();
      return out;
    });
    expect(texts.map((t) => t.chip)).toEqual([
      "Due today",
      "Due in 3 days",
      "Due Dec 15, 2026",
      "Past due date, issuer reports not overdue",
      "Due date unavailable",
    ]);
    expect(texts[1].text).toContain("Reconnect needed (Settings)");
    expect(texts[2].text).toContain("Grant liabilities access (Settings)");
    expect(texts[3].text).toContain("Disconnect incomplete (Settings)");
    expect(texts[0].text).not.toContain("(Settings)");
  });

  it("utilization that cannot be computed says why", () => {
    const view = build([{ fields: fields({ credit_limit: ob("not_supplied"), current_balance: present(10) }) }]);
    render(<CardTile card={view.cards[0]} today={view.today} />);
    expect(screen.getByText("Not computed: credit limit is missing")).toBeTruthy();
  });
});

describe("CurrencyTotals", () => {
  const mixed = build([
    { iso_currency_code: "CAD", fields: fields({ current_balance: present(1000), credit_limit: present(4000), statement_balance: present(800) }) },
    { iso_currency_code: "CAD", fields: fields({ current_balance: present(500), credit_limit: ob("not_supplied"), statement_balance: present(400) }) },
    { iso_currency_code: "USD", fields: fields({ current_balance: present(200), credit_limit: present(1000), statement_balance: present(150) }) },
  ]);

  it("renders separate CAD and USD groups and no combined figure", () => {
    const { container } = render(<CurrencyTotals totals={mixed.totals_by_currency} />);
    const groups = Array.from(container.querySelectorAll("section[data-currency]"));
    expect(groups.map((g) => g.getAttribute("data-currency"))).toEqual(["CAD", "USD"]);

    const cad = within(groups[0] as HTMLElement);
    expect(cad.getByText("Total balance").nextElementSibling?.textContent).toMatch(/1,500\.00/);
    expect(cad.getByText("Due this cycle").nextElementSibling?.textContent).toMatch(/1,200\.00/);
    expect(cad.getByText("Overall utilization").nextElementSibling?.textContent).toBe("25%");
    expect(groups[0].textContent).toContain("computed from 1 card; 1 excluded (missing limit or balance)");

    const usd = within(groups[1] as HTMLElement);
    expect(usd.getByText("Total balance").nextElementSibling?.textContent).toMatch(/200\.00/);
    expect(groups[1].textContent).toContain("computed from 1 card; 0 excluded (missing limit or balance)");

    // 1500 CAD + 200 USD = 1700 must appear nowhere.
    expect(container.textContent).not.toMatch(/1,?700/);
    expect(container.querySelectorAll("section")).toHaveLength(2);
  });

  it("a total nobody reports is shown as missing, not as zero", () => {
    const none = build([{ iso_currency_code: "CAD", fields: fields({ current_balance: ob("error", null, { error_code: "X" }) }) }]);
    const { container } = render(<CurrencyTotals totals={none.totals_by_currency} />);
    expect(container.textContent).toContain("No card reports this");
    expect(container.textContent).not.toMatch(/0\.00/);
  });
});

describe("UrgencyBanner", () => {
  const stamp = "2026-10-31T16:00:00.000Z";
  it("red when overdue, amber when only due soon, quiet otherwise; counts only", () => {
    const { container, rerender } = render(<UrgencyBanner counts={{ overdue: 2, due_soon: 1 }} today="2026-10-31" generatedAt={stamp} />);
    expect(container.textContent).toContain("2 cards overdue · 1 due within 7 days");
    expect(container.textContent).toContain("Today (Toronto) 2026-10-31");
    expect(container.querySelector('[data-tone="overdue"]')).toBeTruthy();

    rerender(<UrgencyBanner counts={{ overdue: 0, due_soon: 1 }} today="2026-10-31" generatedAt={stamp} />);
    expect(container.textContent).toContain("1 card due within 7 days");
    expect(container.querySelector('[data-tone="due_soon"]')).toBeTruthy();

    rerender(<UrgencyBanner counts={{ overdue: 0, due_soon: 0 }} today="2026-10-31" generatedAt={stamp} />);
    expect(container.textContent).toContain("Nothing due in the next 7 days");
    expect(container.querySelector('[data-tone="quiet"]')).toBeTruthy();
  });
});
