import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const ENC_PREFIX = "enc:v1:";
const ALG = "aes-256-gcm";

function deriveKey(secret: string, salt: string): Buffer {
  return scryptSync(secret, salt, 32);
}

export function encryptSecret(plaintext: string, appSecret: string): string {
  const iv = randomBytes(12);
  const key = deriveKey(appSecret, "amexlens-token-v1");
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    ENC_PREFIX +
    iv.toString("base64url") +
    ":" +
    tag.toString("base64url") +
    ":" +
    ct.toString("base64url")
  );
}

export function decryptSecret(stored: string, appSecret: string): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    // Legacy plaintext value; caller should re-encrypt opportunistically.
    return stored;
  }
  const [ivB64, tagB64, ctB64] = stored.slice(ENC_PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("malformed ciphertext");
  }
  const key = deriveKey(appSecret, "amexlens-token-v1");
  const decipher = createDecipheriv(ALG, key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX);
}

// Signed session cookie: base64url(payload).base64url(hmac)
export function signSession(payload: string, appSecret: string): string {
  const mac = createHmac("sha256", appSecret + ":session")
    .update(payload)
    .digest();
  return (
    Buffer.from(payload, "utf8").toString("base64url") +
    "." +
    mac.toString("base64url")
  );
}

export function verifySession(
  token: string | undefined,
  appSecret: string
): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payloadB64 = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);
  let payload: string;
  let givenMac: Buffer;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
    givenMac = Buffer.from(macB64, "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", appSecret + ":session")
    .update(payload)
    .digest();
  if (givenMac.length !== expected.length) return null;
  if (!timingSafeEqual(givenMac, expected)) return null;

  // payload format: "<issuedAt>:<random>" — reject anything older than 30d.
  const [issuedAtStr] = payload.split(":");
  const issuedAt = parseInt(issuedAtStr ?? "", 10);
  if (!Number.isFinite(issuedAt)) return null;
  const ageMs = Date.now() - issuedAt;
  if (ageMs < 0 || ageMs > 30 * 24 * 3600 * 1000) return null;
  return payload;
}

export function newSessionPayload(): string {
  return `${Date.now()}:${randomBytes(16).toString("base64url")}`;
}

// Constant-time string equality, robust to length differences.
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still do a comparison to avoid revealing length differences via timing.
    timingSafeEqual(ab, Buffer.alloc(ab.length));
    return false;
  }
  return timingSafeEqual(ab, bb);
}
