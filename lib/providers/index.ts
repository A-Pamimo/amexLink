import "server-only";
import { plaidProvider } from "./plaid";
import type { CardProvider, ProviderId } from "./types";

/** Registry. A later adapter is appended here when its credentials exist (docs/ARCHITECTURE.md 3). */
export const providers: CardProvider[] = [plaidProvider];

export function getProvider(id: ProviderId): CardProvider | undefined {
  return providers.find((p) => p.id === id);
}
