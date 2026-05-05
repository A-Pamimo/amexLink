import { NextRequest, NextResponse } from "next/server";

const COOKIE = "amexlens_auth";

// Web Crypto-based HMAC verification (middleware runs on the edge runtime,
// so node:crypto is not available). Mirrors lib/crypto.ts.
async function verifySession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const payloadB64 = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);

  let payload: string;
  let mac: Uint8Array;
  try {
    payload = base64urlDecodeToString(payloadB64);
    mac = base64urlDecodeToBytes(macB64);
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret + ":session"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    new TextEncoder().encode(payload)
  );
  if (!ok) return false;

  const issuedAt = parseInt(payload.split(":")[0] ?? "", 10);
  if (!Number.isFinite(issuedAt)) return false;
  const ageMs = Date.now() - issuedAt;
  if (ageMs < 0 || ageMs > 30 * 24 * 3600 * 1000) return false;
  return true;
}

function base64urlDecodeToString(s: string): string {
  return new TextDecoder().decode(base64urlDecodeToBytes(s));
}
function base64urlDecodeToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function middleware(req: NextRequest) {
  const mode = process.env.AUTH_MODE ?? "none";
  if (mode === "none") return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/.well-known") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(COOKIE)?.value;
  if (await verifySession(cookie)) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
