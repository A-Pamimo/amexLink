import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DataKeyInvalidError,
  DataKeyMissingError,
  DecryptError,
  constantTimeEqual,
  decrypt,
  encrypt,
  isEncrypted,
  loadDataKey,
  randomToken,
  resetDataKeyCache,
  sha256Hex,
} from "@/lib/crypto";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const ENV_KEYS = ["TOKEN_ENCRYPTION_KEY", "TOKEN_ENCRYPTION_KEY_FILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let tmpDir: string | null = null;

function tmpFile(name: string, content: Buffer | string, mode = 0o600): string {
  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-crypto-"));
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, { mode });
  fs.chmodSync(p, mode); // writeFileSync mode is subject to umask
  return p;
}

/** Replace one base64url segment of a `v1.iv.tag.ct` value with a byte flipped. */
function flipByte(segment: string, index = 0): string {
  const buf = Buffer.from(segment, "base64url");
  buf[index] ^= 0x01;
  return buf.toString("base64url");
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.TOKEN_ENCRYPTION_KEY = KEY_B64;
  delete process.env.TOKEN_ENCRYPTION_KEY_FILE;
  resetDataKeyCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetDataKeyCache();
  vi.restoreAllMocks();
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("encrypt / decrypt", () => {
  it("round-trips with the same AAD and uses the v1 wire format", () => {
    const ct = encrypt("access-sandbox-123", "plaid_items:A");
    expect(ct).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(isEncrypted(ct)).toBe(true);
    expect(ct).not.toContain("access-sandbox-123");
    expect(decrypt(ct, "plaid_items:A")).toBe("access-sandbox-123");
  });

  it("round-trips unicode and empty plaintext", () => {
    expect(decrypt(encrypt("héllo ✓", "x"), "x")).toBe("héllo ✓");
    expect(decrypt(encrypt("", "x"), "x")).toBe("");
  });

  it("produces different ciphertext (fresh IV) for the same plaintext", () => {
    const a = encrypt("same", "aad");
    const b = encrypt("same", "aad");
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });

  it("rejects an AAD swap (ciphertext moved between rows)", () => {
    const ct = encrypt("tok", "plaid_items:A");
    expect(() => decrypt(ct, "plaid_items:B")).toThrow(DecryptError);
  });

  it("rejects a flipped tag byte and a flipped ciphertext byte", () => {
    const [v, iv, tag, body] = encrypt("tok", "aad").split(".");
    expect(() => decrypt([v, iv, flipByte(tag), body].join("."), "aad")).toThrow(DecryptError);
    expect(() => decrypt([v, iv, tag, flipByte(body)].join("."), "aad")).toThrow(DecryptError);
  });

  it("rejects an unknown key version and malformed input", () => {
    const ct = encrypt("tok", "aad");
    expect(() => decrypt(ct.replace(/^v1\./, "v9."), "aad")).toThrow(DecryptError);
    expect(() => decrypt(ct.replace(/^v1\./, "v9."), "aad")).toThrow(/unknown key version/);
    expect(() => decrypt("not-encrypted", "aad")).toThrow(DecryptError);
    expect(() => decrypt("v1.short.short.x", "aad")).toThrow(DecryptError);
    expect(() => decrypt("", "aad")).toThrow(DecryptError);
  });

  it("DecryptError messages never contain the ciphertext", () => {
    const ct = encrypt("tok", "aad");
    const bad = ct.replace(/^v1\./, "v9.");
    for (const input of [bad, ct, "v1.short.short.x"]) {
      let err: unknown;
      try {
        decrypt(input, "other-aad");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DecryptError);
      const msg = (err as Error).message;
      expect(msg).not.toContain(input);
      expect(msg).not.toContain(ct.split(".")[3]);
      expect(msg).not.toContain("tok");
    }
  });

  it("isEncrypted only matches the versioned prefix", () => {
    expect(isEncrypted("v1.a.b.c")).toBe(true);
    expect(isEncrypted("v12.a.b.c")).toBe(true);
    expect(isEncrypted("access-sandbox-abc")).toBe(false);
    expect(isEncrypted("v.a.b")).toBe(false);
  });
});

describe("loadDataKey", () => {
  it("caches the decoded key and accepts base64url", () => {
    expect(loadDataKey().equals(Buffer.alloc(32, 7))).toBe(true);
    process.env.TOKEN_ENCRYPTION_KEY = "garbage";
    expect(loadDataKey().equals(Buffer.alloc(32, 7))).toBe(true); // cached

    resetDataKeyCache();
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64url");
    expect(loadDataKey().equals(Buffer.alloc(32, 9))).toBe(true);
  });

  it("rejects a 31-byte key with DataKeyInvalidError", () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(31, 1).toString("base64");
    expect(() => loadDataKey()).toThrow(DataKeyInvalidError);
    expect(() => encrypt("x", "a")).toThrow(/31 bytes, expected 32/);
  });

  it("rejects a 33-byte key and non-base64 text", () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(33, 1).toString("base64");
    expect(() => loadDataKey()).toThrow(DataKeyInvalidError);
    resetDataKeyCache();
    process.env.TOKEN_ENCRYPTION_KEY = "not base64!!";
    expect(() => loadDataKey()).toThrow(DataKeyInvalidError);
  });

  it("throws DataKeyMissingError that points at key:generate when unset", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => loadDataKey()).toThrow(DataKeyMissingError);
    expect(() => encrypt("x", "a")).toThrow(/key:generate/);
    expect(() => decrypt("v1.a.b.c", "a")).toThrow(DataKeyMissingError);
  });

  it("treats an empty TOKEN_ENCRYPTION_KEY as unset", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "   ";
    expect(() => loadDataKey()).toThrow(DataKeyMissingError);
  });

  it("reads a base64 key from TOKEN_ENCRYPTION_KEY_FILE", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const key = Buffer.alloc(32, 3);
    process.env.TOKEN_ENCRYPTION_KEY_FILE = tmpFile("key.b64", key.toString("base64") + "\n");
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(loadDataKey().equals(key)).toBe(true);
      expect(decrypt(encrypt("tok", "a"), "a")).toBe("tok");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reads 32 raw bytes from TOKEN_ENCRYPTION_KEY_FILE", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    process.env.TOKEN_ENCRYPTION_KEY_FILE = tmpFile("key.bin", key);
    expect(loadDataKey().equals(key)).toBe(true);
  });

  it("warns once when the key file is group/world readable", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const key = Buffer.alloc(32, 5);
    process.env.TOKEN_ENCRYPTION_KEY_FILE = tmpFile("key.loose", key.toString("base64"), 0o644);
    // lib/log writes warn-level JSON lines to stderr.
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(loadDataKey().equals(key)).toBe(true);
      resetDataKeyCache(); // force a re-read; the warning flag is reset too
      loadDataKey();
      expect(warn).toHaveBeenCalledTimes(2);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('"event":"data_key_file_mode"');
      expect(line).toMatch(/group\/world readable/);
      expect(line).not.toContain(key.toString("base64"));
    } finally {
      warn.mockRestore();
    }
  });

  it("prefers TOKEN_ENCRYPTION_KEY over the file and rejects a bad file", () => {
    process.env.TOKEN_ENCRYPTION_KEY_FILE = tmpFile("key.short", Buffer.alloc(31, 1));
    expect(loadDataKey().equals(Buffer.alloc(32, 7))).toBe(true);

    resetDataKeyCache();
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => loadDataKey()).toThrow(DataKeyInvalidError);

    resetDataKeyCache();
    process.env.TOKEN_ENCRYPTION_KEY_FILE = path.join(tmpDir!, "does-not-exist");
    expect(() => loadDataKey()).toThrow(DataKeyInvalidError);
  });
});

describe("assertBootConfig", () => {
  it("refuses to boot without a data key and passes with one", async () => {
    const { assertBootConfig } = await import("@/lib/boot");
    const umask = process.umask();
    try {
      delete process.env.TOKEN_ENCRYPTION_KEY;
      expect(() => assertBootConfig()).toThrow(DataKeyMissingError);
      process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(31, 1).toString("base64");
      expect(() => assertBootConfig()).toThrow(DataKeyInvalidError);
      process.env.TOKEN_ENCRYPTION_KEY = KEY_B64;
      expect(() => assertBootConfig()).not.toThrow();
    } finally {
      process.umask(umask);
    }
  });
});

describe("helpers", () => {
  it("constantTimeEqual handles equal, different and length-mismatched input", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
  });

  it("sha256Hex matches the known digest for strings and buffers", () => {
    const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(sha256Hex("abc")).toBe(abc);
    expect(sha256Hex(Buffer.from("abc"))).toBe(abc);
  });

  it("randomToken is 43 chars of base64url by default and unique", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
