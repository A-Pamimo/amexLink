import { vi } from "vitest";
import transactionsSync from "../fixtures/plaid/transactions_sync.json";

/**
 * An axios-like Plaid failure: `err.response.data` carries the Plaid error body and, like a
 * real AxiosError, `err.config.data` carries the request (which includes the access token) and
 * `error_message` can echo it. Tests plant tokens here to prove they never escape.
 */
export function plaidError(
  error_code: string,
  opts: {
    status?: number;
    error_type?: string;
    error_message?: string;
    request_id?: string;
    requestBody?: string;
  } = {}
) {
  const err = new Error(`Request failed with status code ${opts.status ?? 400}`) as Error & {
    response: { status: number; data: Record<string, string> };
    config: { data: string; headers: Record<string, string> };
  };
  err.name = "AxiosError";
  err.response = {
    status: opts.status ?? 400,
    data: {
      error_code,
      error_type: opts.error_type ?? "ITEM_ERROR",
      error_message: opts.error_message ?? "provider says no",
      request_id: opts.request_id ?? "req_err_1",
    },
  };
  err.config = {
    data: opts.requestBody ?? "",
    headers: { "PLAID-SECRET": "secret-should-never-leak" },
  };
  return err;
}

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
    itemPublicTokenExchange: vi.fn<(req?: Record<string, unknown>) => Promise<unknown>>(async () => ({
      data: { access_token: "access-sandbox-fake", item_id: "item_fake_001", request_id: "req_x1" },
    })),
    linkTokenCreate: vi.fn<(req?: Record<string, unknown>) => Promise<unknown>>(async () => ({
      data: { link_token: "link-sandbox-fake", expiration: "2026-10-31T00:00:00Z", request_id: "req_x2" },
    })),
    itemRemove: vi.fn<(req?: Record<string, unknown>) => Promise<unknown>>(async () => ({ data: { request_id: "req_x3" } })),
    itemGet: vi.fn<(req?: Record<string, unknown>) => Promise<unknown>>(async () => ({
      data: {
        item: { item_id: "item_fake_001", institution_id: "ins_100533" },
        request_id: "req_x4",
      },
    })),
    institutionsGetById: vi.fn<(req?: Record<string, unknown>) => Promise<unknown>>(async () => ({
      data: {
        institution: { institution_id: "ins_100533", name: "American Express Canada" },
        request_id: "req_x5",
      },
    })),
  };

  vi.doMock("@/lib/plaid", () => ({
    getPlaid: () => fake,
    plaidCountryCodes: () => ["US", "CA"],
    TRANSACTIONS_PRODUCT: ["transactions"],
  }));

  return fake;
}
