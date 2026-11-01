import { vi } from "vitest";
import transactionsSync from "../fixtures/plaid/transactions_sync.json";

/**
 * Replace `@/lib/plaid` with fakes fed from test/fixtures/plaid/*.json.
 *
 * Uses vi.doMock (not hoisted) because it is called from a helper at runtime;
 * call it BEFORE loadApp()/dynamic imports of the modules under test. The mock
 * survives vi.resetModules().
 */
export function installPlaidFake() {
  const fake = {
    transactionsSync: vi.fn<(req: Record<string, unknown>) => Promise<{ data: typeof transactionsSync }>>(
      async () => ({ data: structuredClone(transactionsSync) })
    ),
    itemPublicTokenExchange: vi.fn(async () => ({
      data: { access_token: "access-sandbox-fake", item_id: "item_fake_001", request_id: "req_x1" },
    })),
    linkTokenCreate: vi.fn(async () => ({
      data: { link_token: "link-sandbox-fake", expiration: "2026-10-31T00:00:00Z", request_id: "req_x2" },
    })),
    itemRemove: vi.fn(async () => ({ data: { request_id: "req_x3" } })),
  };

  vi.doMock("@/lib/plaid", () => ({
    getPlaid: () => fake,
    plaidCountryCodes: () => ["US", "CA"],
    TRANSACTIONS_PRODUCT: ["transactions"],
  }));

  return fake;
}
