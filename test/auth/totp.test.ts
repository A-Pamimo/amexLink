import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  otpauthUri,
  stepAt,
  totpAt,
  verifyTotp,
} from "@/lib/auth/totp";

// RFC 6238 Appendix B, HMAC-SHA1, T0 = 0, X = 30, secret "12345678901234567890".
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
];

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC SHA-1 test vectors (8 digits) and their 6-digit truncation", () => {
    for (const [seconds, code8] of VECTORS) {
      const step = stepAt(seconds * 1000);
      expect(totpAt(RFC_SECRET, step, 8)).toBe(code8);
      expect(totpAt(RFC_SECRET, step, 6)).toBe(code8.slice(-6));
    }
  });

  it("accepts the ±1 window and rejects ±2", () => {
    const now = 1111111111 * 1000;
    const step = stepAt(now);
    for (const delta of [-1, 0, 1]) {
      const r = verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + delta), { now });
      expect(r).toEqual({ ok: true, step: step + delta });
    }
    for (const delta of [-2, 2]) {
      expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + delta), { now })).toEqual({ ok: false });
    }
  });

  it("rejects a replay of the same step and anything earlier", () => {
    const now = 1234567890 * 1000;
    const step = stepAt(now);
    const code = totpAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, { now, lastStep: null }).ok).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, { now, lastStep: step }).ok).toBe(false);
    // previous-window code after the current step was accepted
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), { now, lastStep: step }).ok).toBe(false);
    // next step is still fine
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), { now, lastStep: step })).toEqual({
      ok: true,
      step: step + 1,
    });
  });

  it("rejects malformed codes without throwing", () => {
    const now = Date.now();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5", "000000\n"]) {
      expect(verifyTotp(RFC_SECRET, bad, { now }).ok).toBe(false);
    }
    // whitespace inside is tolerated ("123 456" from a phone keyboard)
    const step = stepAt(now);
    const code = totpAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { now }).ok).toBe(true);
  });

  it("base32 round-trips arbitrary bytes and tolerates lowercase/padding/spaces", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 10, 20, 33]) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff));
      const enc = base32Encode(buf);
      expect(enc).toMatch(/^[A-Z2-7]*$/);
      expect(base32Decode(enc)).toEqual(buf);
      expect(base32Decode(enc.toLowerCase() + "===")).toEqual(buf);
    }
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI"); // RFC 4648 §10 without padding
    expect(base32Decode("mzxw 6ytb-oi").toString()).toBe("foobar");
    expect(() => base32Decode("1!")).toThrow();
  });

  it("builds a standard otpauth URI", () => {
    const uri = otpauthUri({ secret: RFC_SECRET, issuer: "AmexLens", account: "localhost:3000" });
    const u = new URL(uri);
    expect(u.protocol).toBe("otpauth:");
    expect(u.host).toBe("totp");
    expect(decodeURIComponent(u.pathname)).toBe("/AmexLens:localhost:3000");
    expect(u.searchParams.get("secret")).toBe(base32Encode(RFC_SECRET));
    expect(u.searchParams.get("issuer")).toBe("AmexLens");
    expect(u.searchParams.get("digits")).toBe("6");
    expect(u.searchParams.get("period")).toBe("30");
    expect(u.searchParams.get("algorithm")).toBe("SHA1");
  });
});
