import { audit } from "@/lib/audit";
import { SETUP_LOCKOUT_SCOPE, authorizeSetup } from "@/lib/auth/factors";
import { errorJson, jsonNoStore, readJsonObject } from "@/lib/auth/http";
import { recordFailure } from "@/lib/auth/lockout";
import { finishRegistration } from "@/lib/auth/passkey";
import { issueSessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Verify a registration response and store the credential. Signs in when it is the first factor. */
export async function POST(req: Request) {
  const body = await readJsonObject(req);
  if (body instanceof Response) return body;
  const gate = await authorizeSetup(req, body);
  if (!gate.ok) return gate.response;

  const outcome = await finishRegistration({
    challenge_id: body.challenge_id,
    response: body.response,
    label: body.label,
  });
  if (!outcome.ok) {
    recordFailure(SETUP_LOCKOUT_SCOPE);
    await audit("auth.setup.passkey", { outcome: outcome.reason });
    return errorJson(400, "passkey_rejected");
  }
  await audit("auth.setup.passkey", { outcome: "ok" });

  const res = jsonNoStore({ ok: true, id: outcome.id });
  if (gate.firstFactor) await issueSessionCookie(req, res);
  return res;
}
