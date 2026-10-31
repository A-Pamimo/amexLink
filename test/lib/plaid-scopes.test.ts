import { CreditAccountSubtype, Products } from "plaid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { installPlaidFake } from "../helpers/plaid-fake";

beforeEach(() => vi.resetModules());
afterEach(() => closeApp());

describe("Link constants and assertLeastPrivilege (SECURITY.md 3.5, P-E1)", () => {
  it("exports exactly Transactions / Liabilities / credit-card filter", async () => {
    const m = await import("@/lib/plaid");
    expect(m.LINK_PRODUCTS).toEqual(["transactions"]);
    expect(m.LINK_REQUIRED_IF_SUPPORTED).toEqual(["liabilities"]);
    expect(m.LINK_ACCOUNT_FILTERS).toEqual({ credit: { account_subtypes: ["credit card"] } });
    expect(() => m.assertLeastPrivilege()).not.toThrow();
  });

  it.each([Products.Auth, Products.Identity, Products.Investments, Products.Transfer, Products.Statements, Products.Balance])(
    "throws when %s is injected into any product list",
    async (product) => {
      const { assertLeastPrivilege } = await import("@/lib/plaid");
      expect(() => assertLeastPrivilege({ products: [Products.Transactions, product] })).toThrow(/Least-privilege/);
      expect(() => assertLeastPrivilege({ requiredIfSupported: [Products.Liabilities, product] })).toThrow(/Least-privilege/);
      expect(() => assertLeastPrivilege({ additionalConsented: [product] })).toThrow(/Least-privilege/);
    }
  );

  it("allows the update-mode shape (Liabilities as additional consent)", async () => {
    const { assertLeastPrivilege } = await import("@/lib/plaid");
    expect(() => assertLeastPrivilege({ products: [], additionalConsented: [Products.Liabilities] })).not.toThrow();
  });

  it("rejects account filters that are not credit-card only", async () => {
    const { assertLeastPrivilege } = await import("@/lib/plaid");
    expect(() => assertLeastPrivilege({ accountFilters: { depository: { account_subtypes: [] } } as never })).toThrow(/credit cards only/);
    expect(() =>
      assertLeastPrivilege({
        accountFilters: { credit: { account_subtypes: [CreditAccountSubtype.CreditCard] }, loan: { account_subtypes: [] } } as never,
      })
    ).toThrow(/credit cards only/);
    expect(() =>
      assertLeastPrivilege({ accountFilters: { credit: { account_subtypes: [CreditAccountSubtype.All] } } })
    ).toThrow(/credit cards only/);
    expect(() => assertLeastPrivilege({ accountFilters: {} })).toThrow(/credit cards only/);
  });

  it("assertBootConfig runs the scope check", async () => {
    const boot = await import("@/lib/boot");
    expect(() => boot.assertBootConfig()).not.toThrow();
  });
});

describe("POST /api/plaid/link-token request shape", () => {
  it("asks for transactions + required_if_supported liabilities, credit-card filter, random stable client_user_id", async () => {
    const plaid = installPlaidFake();
    await loadApp();
    const { resetRateLimits } = await import("@/lib/http/rate-limit");
    resetRateLimits();
    const { POST } = await import("@/app/api/plaid/link-token/route");

    expect((await POST()).status).toBe(200);
    expect((await POST()).status).toBe(200);
    expect(plaid.linkTokenCreate).toHaveBeenCalledTimes(2);

    const [a, b] = plaid.linkTokenCreate.mock.calls.map((c) => c[0] as Record<string, unknown> & { user: { client_user_id: string } });
    expect(a.products).toEqual(["transactions"]);
    expect(a.required_if_supported_products).toEqual(["liabilities"]);
    expect(a.account_filters).toEqual({ credit: { account_subtypes: ["credit card"] } });
    expect(a.client_name).toBe("AmexLens");
    // balance is not a product; nothing else widens the consent
    expect(JSON.stringify(a)).not.toMatch(/"(auth|identity|investments|transfer|statements|balance)"/);
    expect(Object.keys(a).sort()).toEqual(
      ["account_filters", "client_name", "country_codes", "language", "products", "required_if_supported_products", "user"].sort()
    );

    expect(a.user.client_user_id).not.toBe("amexlens-local-user");
    expect(a.user.client_user_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.user.client_user_id).toBe(a.user.client_user_id);
  });

  it("client_user_id is stored in settings, survives a restart, and never overwrites an existing value", async () => {
    installPlaidFake();
    const { db } = await loadApp();
    const { getOrCreateClientUserId } = await import("@/lib/plaid-user");
    const [x, y] = await Promise.all([getOrCreateClientUserId(), getOrCreateClientUserId()]);
    expect(x).toBe(y); // concurrent first calls share one id
    expect(await db.getSetting("plaid_client_user_id")).toBe(x);
    expect(await getOrCreateClientUserId()).toBe(x);

    await db.setSetting("plaid_client_user_id", "preset-id");
    expect(await getOrCreateClientUserId()).toBe("preset-id");
  });
});
