import { audit } from "@/lib/audit";
import { requireMutation } from "@/lib/auth/guard";
import { jsonNoStore } from "@/lib/auth/http";
import { generateRecoveryCodes } from "@/lib/auth/recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Regenerate the 10 recovery codes (session required). Old codes stop working. */
export async function POST(req: Request) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;
  const recovery_codes = await generateRecoveryCodes();
  await audit("auth.setup.recovery", { outcome: "regenerated" });
  return jsonNoStore({ recovery_codes });
}
