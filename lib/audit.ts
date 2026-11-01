import "server-only";
import { getDB } from "./db";

export interface AuditFields {
  item_id?: string;
  outcome?: string;
  detail?: string;
}

/**
 * Append a row to security_log.
 *
 * NEVER pass access tokens, public tokens, passwords, secrets, provider error
 * bodies or full account numbers in any field (including `detail`). Use short
 * codes and ids only.
 */
export async function audit(event: string, fields: AuditFields = {}): Promise<void> {
  const db = await getDB();
  await db.appendSecurityLog({
    event,
    item_id: fields.item_id ?? null,
    outcome: fields.outcome ?? null,
    detail: fields.detail ?? null,
  });
}
