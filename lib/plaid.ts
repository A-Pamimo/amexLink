import "server-only";
import {
  Configuration,
  CountryCode,
  CreditAccountSubtype,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type LinkTokenAccountFilters,
} from "plaid";
import { env } from "./env";

let cached: PlaidApi | null = null;

export function getPlaid(): PlaidApi {
  if (cached) return cached;
  const config = new Configuration({
    basePath: PlaidEnvironments[env.PLAID_ENV],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID,
        "PLAID-SECRET": env.PLAID_SECRET,
      },
    },
  });
  cached = new PlaidApi(config);
  return cached;
}

export function plaidCountryCodes(): CountryCode[] {
  return env.PLAID_COUNTRY_CODES
    .map((c) => c.toUpperCase())
    .filter((c): c is CountryCode =>
      (Object.values(CountryCode) as string[]).includes(c)
    );
}

// ---------------------------------------------------------------------------------------
// Link scopes (SECURITY.md 3.5, P-E1, P-I2). Least privilege, in one place.
//  - `products`: Transactions only, so an issuer without Liabilities can still link.
//  - `required_if_supported_products`: Liabilities. Plaid collects consent when the
//    institution supports it; otherwise Link still succeeds.
//  - `balance` is NOT a product: Plaid initialises it with the others. The billed
//    `/accounts/balance/get` call is separate and only made by the explicit refresh route.
//  - Credit cards only: depository / loan / investment accounts are never offered.
// ---------------------------------------------------------------------------------------
export const LINK_PRODUCTS: Products[] = [Products.Transactions];
export const LINK_REQUIRED_IF_SUPPORTED: Products[] = [Products.Liabilities];
export const LINK_ACCOUNT_FILTERS: LinkTokenAccountFilters = {
  credit: { account_subtypes: [CreditAccountSubtype.CreditCard] },
};

const ALLOWED_PRODUCTS = new Set<string>([Products.Transactions, Products.Liabilities]);

export interface LinkScopes {
  products?: readonly string[];
  requiredIfSupported?: readonly string[];
  /** `additional_consented_products` (update mode). */
  additionalConsented?: readonly string[];
  accountFilters?: LinkTokenAccountFilters;
}

/**
 * Throws if any Link product list asks for anything beyond Transactions + Liabilities
 * (Auth, Identity, Investments, Transfer, Statements, Balance, ...), or if the account filter is
 * anything but credit cards. Defaults to the constants above; arguments exist so tests and the
 * update-mode variants can check their own lists.
 */
export function assertLeastPrivilege(scopes: LinkScopes = {}): void {
  const lists: Array<[string, readonly string[]]> = [
    ["products", scopes.products ?? LINK_PRODUCTS],
    ["required_if_supported_products", scopes.requiredIfSupported ?? LINK_REQUIRED_IF_SUPPORTED],
    ["additional_consented_products", scopes.additionalConsented ?? []],
  ];
  for (const [name, list] of lists) {
    for (const p of list) {
      if (!ALLOWED_PRODUCTS.has(p)) {
        throw new Error(`Least-privilege violation: ${name} contains "${p}" (only transactions and liabilities are allowed)`);
      }
    }
  }
  const filters = scopes.accountFilters ?? LINK_ACCOUNT_FILTERS;
  const keys = Object.keys(filters).filter((k) => (filters as Record<string, unknown>)[k] !== undefined);
  const subtypes = filters.credit?.account_subtypes ?? [];
  if (
    keys.length !== 1 ||
    keys[0] !== "credit" ||
    subtypes.length !== 1 ||
    subtypes[0] !== CreditAccountSubtype.CreditCard
  ) {
    throw new Error("Least-privilege violation: account_filters must be credit cards only");
  }
}
