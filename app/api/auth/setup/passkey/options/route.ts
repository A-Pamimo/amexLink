import { authorizeSetup } from "@/lib/auth/factors";
import { jsonNoStore, readJsonObject } from "@/lib/auth/http";
import { beginRegistration } from "@/lib/auth/passkey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Registration options (challenge stored server-side, 5-minute TTL, single use). */
export async function POST(req: Request) {
  const body = await readJsonObject(req);
  if (body instanceof Response) return body;
  const gate = await authorizeSetup(req, body);
  if (!gate.ok) return gate.response;
  const { challenge_id, options } = await beginRegistration();
  return jsonNoStore({ challenge_id, options });
}
