import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { REQUIRED_ENV, makeReq, tokenFromResponse } from "../helpers/auth";

afterEach(() => closeApp());

describe("recovery codes", () => {
  it("generates 10 xxxxx-xxxxx codes, stores hashes only, each usable once", async () => {
    const { db } = await loadApp(REQUIRED_ENV);
    const { consumeRecoveryCode, generateRecoveryCodes, hashRecoveryCode } = await import(
      "@/lib/auth/recovery"
    );
    const codes = await generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);

    expect(await db.countRecoveryCodes()).toEqual({ total: 10, remaining: 10 });
    // Nothing in the table equals a plaintext code.
    expect(await db.consumeRecoveryCode(codes[0])).toBe(false);
    expect(await db.consumeRecoveryCode(hashRecoveryCode(codes[0]))).toBe(true);
    expect(await db.consumeRecoveryCode(hashRecoveryCode(codes[0]))).toBe(false);

    expect(await consumeRecoveryCode(codes[1])).toBe(true);
    expect(await consumeRecoveryCode(codes[1])).toBe(false);
    expect(await db.countRecoveryCodes()).toEqual({ total: 10, remaining: 8 });
  });

  it("normalises case, dashes and whitespace; rejects junk", async () => {
    await loadApp(REQUIRED_ENV);
    const { consumeRecoveryCode, generateRecoveryCodes, normalizeRecoveryCode } = await import(
      "@/lib/auth/recovery"
    );
    const [a, b, c] = await generateRecoveryCodes();
    expect(normalizeRecoveryCode(" AB2DE-fgh34 ")).toBe("ab2defgh34");
    expect(await consumeRecoveryCode(a.toUpperCase())).toBe(true);
    expect(await consumeRecoveryCode(b.replace("-", ""))).toBe(true);
    expect(await consumeRecoveryCode(` ${c.slice(0, 5)} ${c.slice(6)} `)).toBe(true);
    expect(await consumeRecoveryCode("")).toBe(false);
    expect(await consumeRecoveryCode("abcde-fghij-klmno")).toBe(false);
    expect(await consumeRecoveryCode("zzzzz-zzzzz")).toBe(false);
  });

  it("regenerating replaces the old set", async () => {
    await loadApp(REQUIRED_ENV);
    const { consumeRecoveryCode, generateRecoveryCodes } = await import("@/lib/auth/recovery");
    const [old] = await generateRecoveryCodes();
    const [fresh] = await generateRecoveryCodes();
    expect(await consumeRecoveryCode(old)).toBe(false);
    expect(await consumeRecoveryCode(fresh)).toBe(true);
  });

  it("POST /api/auth/login/recovery signs in once per code and sets the cookie", async () => {
    await loadApp(REQUIRED_ENV);
    const { generateRecoveryCodes } = await import("@/lib/auth/recovery");
    const { requireSession } = await import("@/lib/auth/session");
    const { POST } = await import("@/app/api/auth/login/recovery/route");
    const [code] = await generateRecoveryCodes();

    const ok = await POST(makeReq("/api/auth/login/recovery", { method: "POST", body: { code } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, recovery_codes_remaining: 9 });
    const token = tokenFromResponse(ok);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await requireSession(makeReq("/x", { token }))).ok).toBe(true);

    const again = await POST(makeReq("/api/auth/login/recovery", { method: "POST", body: { code } }));
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: { code: "invalid_code" } });
    expect(tokenFromResponse(again)).toBeNull();
  });
});
