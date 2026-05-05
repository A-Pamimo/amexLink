import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { constantTimeEqual, newSessionPayload, signSession } from "@/lib/crypto";
import { env } from "@/lib/env";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (!csrf.ok) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (env.AUTH_MODE !== "password") {
    return NextResponse.json({ error: "auth disabled" }, { status: 400 });
  }

  // 5 attempts per IP per 10 minutes. Defends against brute-force without
  // breaking legitimate retry-after-typo flows.
  const limit = rateLimit(clientKey(req, "auth:login"), 5, 10 * 60 * 1000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "too many attempts" },
      {
        status: 429,
        headers: { "retry-after": String(limit.retryAfterSec) },
      }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const provided = typeof body?.password === "string" ? body.password : "";
  if (!constantTimeEqual(provided, env.AUTH_PASSWORD ?? "")) {
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }

  const token = signSession(newSessionPayload(), env.APP_SECRET);
  const useSecure =
    env.COOKIE_SECURE === "true" ||
    (env.COOKIE_SECURE === "auto" && new URL(req.url).protocol === "https:");

  const res = NextResponse.json({ ok: true });
  res.cookies.set("amexlens_auth", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecure,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
