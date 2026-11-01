"use client";
import { PlaidLinkButton } from "@/components/PlaidLinkButton";
import { SyncButton } from "@/components/SyncButton";
import type { LiabilitiesStatus } from "@/lib/providers/types";
import type { ItemStatus } from "@/lib/types";

export interface ItemActionsProps {
  /** A row of `GET /api/items`. */
  item: {
    item_id: string;
    status: ItemStatus;
    liabilities_status?: LiabilitiesStatus | null;
  };
}

/**
 * Per-card actions on /settings: Link in update mode when Plaid needs something from the owner,
 * plus the plain sync button.
 *  - "Grant liabilities access": the item or its last liabilities call says `consent_required`.
 *  - "Reconnect": the login is no longer valid (`needs_relink`).
 */
export function ItemActions({ item }: ItemActionsProps) {
  const needsConsent = item.status === "consent_required" || item.liabilities_status === "consent_required";
  const needsRelink = item.status === "needs_relink";
  return (
    <>
      {needsRelink && <PlaidLinkButton mode="repair" itemId={item.item_id} label="Reconnect" compact />}
      {needsConsent && (
        <PlaidLinkButton mode="consent" itemId={item.item_id} label="Grant liabilities access" compact />
      )}
      <SyncButton itemId={item.item_id} />
    </>
  );
}
