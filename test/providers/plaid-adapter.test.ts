import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole } from "../helpers/console";
import { installPlaidFake, plaidError } from "../helpers/plaid-fake";
import accountsGetFixture from "../fixtures/plaid/accounts_get.json";
import liabilitiesFixture from "../fixtures/plaid/liabilities_get.json";
import { LIABILITY_FIELDS } from "@/lib/providers/plaid-fields";
import type { ProviderCard, ProviderRefresh } from "@/lib/providers/types";

let con: ReturnType<typeof captureConsole>;
beforeEach(() => {
  con = captureConsole();
  vi.resetModules();
});
afterEach(() => con.restore());

const SECRET = { access_token: "access-sandbox-adapter-test" };

async function setup() {
  const plaid = installPlaidFake();
  const { plaidProvider } = await import("@/lib/providers/plaid");
  return { plaid, plaidProvider };
}

const byId = (r: ProviderRefresh, id: string): ProviderCard => {
  const c = r.cards.find((x) => x.provider_account_id === id);
  if (!c) throw new Error(`card ${id} missing`);
  return c;
};

describe("plaid adapter happy path", () => {
  it("keeps only credit accounts, uses cached /accounts/get by default", async () => {
    const { plaid, plaidProvider } = await setup();
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: false });

    expect(plaid.accountsGet).toHaveBeenCalledTimes(1);
    expect(plaid.accountsBalanceGet).not.toHaveBeenCalled();
    expect(r).toMatchObject({ accounts_fetched: true, balance_source: "cached", liabilities_status: "ok", error_code: null });
    expect(r.cards.map((c) => c.provider_account_id).sort()).toEqual(["acc_amex_cad", "acc_visa_usd"]);

    // liabilities is asked only about the credit accounts
    expect(plaid.liabilitiesGet.mock.calls[0][0]).toMatchObject({
      options: { account_ids: ["acc_amex_cad", "acc_visa_usd"] },
    });

    const amex = byId(r, "acc_amex_cad");
    expect(amex).toMatchObject({ mask: "1005", iso_currency_code: "CAD", subtype: "credit card" });
    expect(amex.fields.current_balance).toMatchObject({ status: "present", value: 1500.18 });
    expect(amex.fields.available_credit).toMatchObject({ status: "present", value: 8499.82 });
    expect(amex.fields.credit_limit).toMatchObject({ status: "present", value: 10000 });
    expect(amex.fields.statement_balance?.value).toBe(1420.18);
    expect(amex.fields.minimum_payment?.value).toBe(35);
    expect(amex.fields.next_payment_due_date?.value).toBe("2026-11-15");
    expect(amex.fields.last_payment_amount?.value).toBe(500);
    expect(amex.fields.last_payment_date?.value).toBe("2026-10-16");
    expect(amex.fields.last_statement_issue_date?.value).toBe("2026-10-26");
    const aprs = amex.fields.apr?.value as Array<{ apr_type: string; apr_percentage: number }>;
    expect(aprs.map((a) => a.apr_type)).toEqual(["purchase_apr", "cash_apr", "penalty_apr"]);
    expect(aprs[2].apr_percentage).toBe(29.99);
  });

  it("uses /accounts/balance/get only when realtimeBalance is set", async () => {
    const { plaid, plaidProvider } = await setup();
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: true });
    expect(plaid.accountsBalanceGet).toHaveBeenCalledTimes(1);
    expect(plaid.accountsGet).not.toHaveBeenCalled();
    expect(r.balance_source).toBe("realtime");
    expect(byId(r, "acc_amex_cad").fields.current_balance?.value).toBe(2000);
  });

  it("never copies forbidden Plaid fields into the result", async () => {
    const { plaidProvider } = await setup();
    const text = JSON.stringify(await plaidProvider.refresh(SECRET, { realtimeBalance: false }));
    for (const planted of ["123456789", "011401533", "371449635398431", "Pat Example", "pat@example.test", "cash_advance", "numbers", "owners", "p_acc_amex_cad", "Everyday Chequing", "acc_chequing"]) {
      expect(text).not.toContain(planted);
    }
  });

  it("only the fields in the allowlist are produced, and every observation is stamped", async () => {
    const { plaidProvider } = await setup();
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: false });
    for (const c of r.cards) {
      expect(Object.keys(c).sort()).toEqual(
        ["fields", "iso_currency_code", "mask", "name", "official_name", "provider_account_id", "subtype", "type"].sort()
      );
      for (const o of Object.values(c.fields)) {
        expect(Object.keys(o).sort()).toEqual(["error_code", "observed_at", "status", "value"]);
        expect(new Date(o.observed_at).toISOString()).toBe(o.observed_at);
      }
    }
  });
});

describe("field status rules", () => {
  it("is_overdue:false is present (not a gap); is_overdue null is not_supplied", async () => {
    const { plaidProvider } = await setup();
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: false });
    expect(byId(r, "acc_amex_cad").fields.is_overdue).toMatchObject({ status: "present", value: false });
    expect(byId(r, "acc_visa_usd").fields.is_overdue).toMatchObject({ status: "not_supplied", value: null });
  });

  it("empty aprs is not_supplied; null nested values are not_supplied", async () => {
    const { plaidProvider } = await setup();
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: false });
    const visa = byId(r, "acc_visa_usd");
    expect(visa.fields.apr).toMatchObject({ status: "not_supplied", value: null, error_code: null });
    expect(visa.fields.minimum_payment?.status).toBe("not_supplied");
    expect(visa.fields.last_payment_amount?.status).toBe("not_supplied");
    expect(visa.fields.statement_balance).toMatchObject({ status: "present", value: 240.1 });
  });

  it("a null balance is not_supplied", async () => {
    const { plaid, plaidProvider } = await setup();
    const data = structuredClone(accountsGetFixture);
    data.accounts[0].balances.limit = null as unknown as number;
    plaid.accountsGet.mockResolvedValueOnce({ data });
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: false });
    expect(byId(r, "acc_amex_cad").fields.credit_limit).toMatchObject({ status: "not_supplied", value: null });
  });

  it("a credit account missing from the liabilities response gets not_supplied liability fields", async () => {
    const { plaid, plaidProvider } = await setup();
    const data = structuredClone(liabilitiesFixture);
    data.liabilities.credit = data.liabilities.credit.filter((c) => c.account_id !== "acc_visa_usd");
    plaid.liabilitiesGet.mockResolvedValueOnce({ data });
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: false });
    const visa = byId(r, "acc_visa_usd");
    for (const k of LIABILITY_FIELDS) expect(visa.fields[k]?.status).toBe("not_supplied");
    expect(r.liabilities_status).toBe("ok");
  });
});

describe("liabilities error mapping", () => {
  const cases: Array<[string, number, ProviderRefresh["liabilities_status"], string]> = [
    ["ADDITIONAL_CONSENT_REQUIRED", 400, "consent_required", "consent_required"],
    ["PRODUCTS_NOT_SUPPORTED", 400, "not_supported", "not_supported"],
    ["NO_LIABILITY_ACCOUNTS", 400, "not_supported", "not_supported"],
    ["PRODUCT_NOT_SUPPORTED", 400, "not_supported", "not_supported"],
    ["PRODUCT_NOT_READY", 400, "pending", "error"],
    ["INTERNAL_SERVER_ERROR", 500, "error", "error"],
    ["RATE_LIMIT_EXCEEDED", 429, "error", "error"],
  ];

  it.each(cases)("%s -> liabilities_status %s, every liability field %s", async (code, status, liab, field) => {
    const { plaid, plaidProvider } = await setup();
    plaid.liabilitiesGet.mockRejectedValueOnce(
      plaidError(code, {
        status,
        error_type: code === "ADDITIONAL_CONSENT_REQUIRED" ? "INVALID_INPUT" : "API_ERROR",
        error_message: "echoes access-sandbox-leak and 371449635398431",
      })
    );
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: false });
    expect(r.liabilities_status).toBe(liab);
    expect(r.error_code).toBe(code);
    expect(r.accounts_fetched).toBe(true);
    expect(r.cards).toHaveLength(2);
    for (const card of r.cards) {
      // balances still come from accounts
      expect(card.fields.current_balance?.status).toBe("present");
      for (const k of LIABILITY_FIELDS) {
        expect(card.fields[k]).toMatchObject({ status: field, value: null, error_code: code });
      }
    }
    // the provider's message/body never reaches the result or the logs
    expect(JSON.stringify(r)).not.toContain("371449635398431");
    expect(con.text()).not.toContain("access-sandbox-leak");
    expect(con.text()).not.toContain("371449635398431");
  });

  it("an unexpected non-provider failure becomes status error with UNKNOWN and does not throw", async () => {
    const { plaid, plaidProvider } = await setup();
    plaid.liabilitiesGet.mockRejectedValueOnce(new TypeError("boom 371449635398431"));
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: false });
    expect(r.liabilities_status).toBe("error");
    expect(r.error_code).toBe("UNKNOWN");
    expect(JSON.stringify(r)).not.toContain("boom");
  });

  it("no credit accounts at all: liabilities is not asked and reported not_supported", async () => {
    const { plaid, plaidProvider } = await setup();
    const data = structuredClone(accountsGetFixture);
    data.accounts = data.accounts.filter((a) => a.type !== "credit");
    plaid.accountsGet.mockResolvedValueOnce({ data });
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: false });
    expect(plaid.liabilitiesGet).not.toHaveBeenCalled();
    expect(r).toMatchObject({ accounts_fetched: true, cards: [], liabilities_status: "not_supported", error_code: "NO_LIABILITY_ACCOUNTS" });
  });
});

describe("balance fallback", () => {
  it("realtime failure falls back to /accounts/get and reports cached", async () => {
    const { plaid, plaidProvider } = await setup();
    plaid.accountsBalanceGet.mockRejectedValueOnce(plaidError("PRODUCT_NOT_READY", { status: 400 }));
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: true });
    expect(plaid.accountsBalanceGet).toHaveBeenCalledTimes(1);
    expect(plaid.accountsGet).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ accounts_fetched: true, balance_source: "cached", liabilities_status: "ok" });
    expect(byId(r, "acc_amex_cad").fields.current_balance?.value).toBe(1500.18);
  });

  it("both failing: accounts_fetched false, no cards, source error, liabilities never asked", async () => {
    const { plaid, plaidProvider } = await setup();
    plaid.accountsBalanceGet.mockRejectedValueOnce(plaidError("INTERNAL_SERVER_ERROR", { status: 500 }));
    plaid.accountsGet.mockRejectedValueOnce(plaidError("ITEM_LOGIN_REQUIRED", { status: 400 }));
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: true });
    expect(r).toMatchObject({
      accounts_fetched: false,
      balance_source: "error",
      error_code: "ITEM_LOGIN_REQUIRED",
      cards: [],
    });
    expect(plaid.liabilitiesGet).not.toHaveBeenCalled();
  });

  it("cached-only failure (no realtime requested) is also accounts_fetched false", async () => {
    const { plaid, plaidProvider } = await setup();
    plaid.accountsGet.mockRejectedValueOnce(new Error("network"));
    const r = await plaidProvider.refresh(SECRET, { realtimeBalance: false });
    expect(r).toMatchObject({ accounts_fetched: false, balance_source: "error", error_code: "UNKNOWN", cards: [] });
  });
});
