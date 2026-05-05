import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (!csrf.ok) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const useSecure =
    env.COOKIE_SECURE === "true" ||
    (env.COOKIE_SECURE === "auto" && new URL(req.url).protocol === "https:");
  const res = NextResponse.json({ ok: true });
  res.cookies.set("amexlens_auth", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecure,
    path: "/",
    maxAge: 0,
  });
  return res;
}
