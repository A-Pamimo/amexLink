import "server-only";
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
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

export const TRANSACTIONS_PRODUCT: Products[] = [Products.Transactions];
