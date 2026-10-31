import { describe, expect, it } from "vitest";
import { mergeCards, normalizeInstitution, reconciliationKey } from "@/lib/cards/merge";
import { FIELD_KEYS, PROVIDER_PRIORITY } from "@/lib/providers/types";
import { makeRow, ob, present } from "../helpers/cards";

describe("mergeCards priority matrix", () => {
  it("plaid not_supported vs yodlee present: yodlee's value wins", () => {
    const [m, ...rest] = mergeCards([
      makeRow({ id: "p", provider: "plaid", fields: { minimum_payment: ob("not_supported", null, { error_code: "PRODUCTS_NOT_SUPPORTED" }) } }),
      makeRow({ id: "y", provider: "yodlee", provider_account_id: "y-1", fields: { minimum_payment: present(35) } }),
    ]);
    expect(rest).toHaveLength(0);
    expect(m.fields.minimum_payment).toMatchObject({ status: "present", value: 35, provider: "yodlee" });
  });

  it("plaid not_supplied vs yodlee not_supported: plaid's not_supplied is kept", () => {
    const [m] = mergeCards([
      makeRow({ id: "y", provider: "yodlee", provider_account_id: "y-1", fields: { apr: ob("not_supported") } }),
      makeRow({ id: "p", provider: "plaid", fields: { apr: ob("not_supplied") } }),
    ]);
    expect(m.fields.apr).toMatchObject({ status: "not_supplied", provider: "plaid" });
  });

  it("two present values: plaid wins regardless of row order", () => {
    for (const order of [["p", "y"], ["y", "p"]]) {
      const rows = order.map((id) =>
        id === "p"
          ? makeRow({ id: "p", provider: "plaid", fields: { current_balance: present(100) } })
          : makeRow({ id: "y", provider: "yodlee", provider_account_id: "y-1", fields: { current_balance: present(999) } })
      );
      const [m] = mergeCards(rows);
      expect(m.fields.current_balance).toMatchObject({ value: 100, provider: "plaid" });
      expect(m.id).toBe("p");
      expect(m.account_ids.sort()).toEqual(["p", "y"]);
    }
  });

  it("is_overdue false is a real value and beats a non-present observation", () => {
    const [m] = mergeCards([
      makeRow({ id: "p", provider: "plaid", fields: { is_overdue: ob("not_supplied") } }),
      makeRow({ id: "m", provider: "mx", provider_account_id: "m-1", fields: { is_overdue: present(false) } }),
    ]);
    expect(m.fields.is_overdue).toMatchObject({ status: "present", value: false, provider: "mx" });
  });

  it("same provider twice: the newer present observation wins", () => {
    const [m] = mergeCards([
      makeRow({ id: "old", provider_account_id: "a", fields: { current_balance: { ...present(1), observed_at: "2026-10-01T00:00:00.000Z" } } }),
      makeRow({ id: "new", provider_account_id: "b", fields: { current_balance: { ...present(2), observed_at: "2026-10-30T00:00:00.000Z" } } }),
    ]);
    expect(m.fields.current_balance.value).toBe(2);
  });

  it("every field key is present on the output, even when nobody observed it", () => {
    const [m] = mergeCards([makeRow({ fields: { current_balance: present(5) } })]);
    expect(Object.keys(m.fields).sort()).toEqual([...FIELD_KEYS].sort());
    expect(m.fields.apr).toMatchObject({ status: "not_supplied", error_code: "NO_OBSERVATION" });
  });

  it("keeps the documented provider order", () => {
    expect(PROVIDER_PRIORITY).toEqual(["plaid", "yodlee", "mx", "flinks"]);
  });
});

describe("reconciliation key", () => {
  it("normalises institution, uses last 4 of the mask and the currency", () => {
    expect(normalizeInstitution("  Banque Désjardins (Québec) ")).toBe("banquedesjardinsquebec");
    expect(reconciliationKey(makeRow({ institution_name: "American Express Canada", mask: "001005" }))).toBe(
      "americanexpresscanada:1005:CAD"
    );
  });

  it("merges the same card across providers but never across currencies", () => {
    const merged = mergeCards([
      makeRow({ id: "a", provider: "plaid", institution_name: "AMEX Canada", mask: "1005" }),
      makeRow({ id: "b", provider: "yodlee", provider_account_id: "y", institution_name: "amex canada", mask: "1005" }),
      makeRow({ id: "c", provider_account_id: "pa-usd", institution_name: "AMEX Canada", mask: "1005", iso_currency_code: "USD" }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("falls back to provider:account when institution AND mask are missing", () => {
    const a = makeRow({ id: "a", provider_account_id: "pa-a", institution_name: null, mask: null });
    const b = makeRow({ id: "b", provider_account_id: "pa-b", institution_name: null, mask: null });
    expect(reconciliationKey(a)).toBe("plaid:pa-a");
    expect(mergeCards([a, b])).toHaveLength(2);
  });
});

describe("utilization", () => {
  const util = (fields: Parameters<typeof makeRow>[0]) => mergeCards([makeRow(fields)])[0].utilization;

  it("is balance / limit only when both are present and the limit is positive", () => {
    expect(util({ fields: { current_balance: present(250), credit_limit: present(1000) } })).toEqual({
      ratio: 0.25,
      computed: true,
    });
  });

  it("is null with a reason when an input is missing or the limit is not positive", () => {
    expect(util({ fields: { current_balance: present(250), credit_limit: ob("not_supplied") } })).toMatchObject({
      ratio: null,
      computed: true,
      reason: "missing_credit_limit",
    });
    expect(util({ fields: { current_balance: ob("error"), credit_limit: present(1000) } })).toMatchObject({
      ratio: null,
      reason: "missing_current_balance",
    });
    expect(util({ fields: { current_balance: present(10), credit_limit: present(0) } })).toMatchObject({
      ratio: null,
      reason: "credit_limit_not_positive",
    });
  });
});
