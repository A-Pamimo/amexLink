import "server-only";
import fs from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { log } from "./log";

/**
 * Crypto core (SECURITY.md 3.1 / 3.2).
 *
 * - One 32-byte data key from TOKEN_ENCRYPTION_KEY (base64 / base64url) or
 *   TOKEN_ENCRYPTION_KEY_FILE (base64 text or 32 raw bytes). Never derived from
 *   a password, never auto-generated into data/.
 * - AES-256-GCM, 12-byte random nonce per write, 16-byte tag, caller-supplied
 *   AAD (e.g. "plaid_items:<item_id>") so ciphertext cannot be moved between rows.
 * - Wire format: `v<version>.<iv b64url>.<tag b64url>.<ct b64url>`. The version
 *   selects a key in the key ring, which is how rotation adds `v2` later.
 *
 * Nothing in this module logs key material, and no error message carries it,
 * plaintext or ciphertext.
 */

const ALG = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CURRENT_VERSION = 1;

const KEY_HINT =
  "Generate one with `npm run key:generate`, store it in a password manager, " +
  "and pass it as TOKEN_ENCRYPTION_KEY (base64) or TOKEN_ENCRYPTION_KEY_FILE (path). " +
  "Keep it out of data/, backups and git.";

export class DataKeyMissingError extends Error {
  constructor() {
    super(
      "TOKEN_ENCRYPTION_KEY is not set (and TOKEN_ENCRYPTION_KEY_FILE is not set). " +
        KEY_HINT
    );
    this.name = "DataKeyMissingError";
  }
}

export class DataKeyInvalidError extends Error {
  constructor(detail: string) {
    super(`Invalid data key: ${detail}. ${KEY_HINT}`);
    this.name = "DataKeyInvalidError";
  }
}

/** Decrypt failure. The message is a fixed reason; it never echoes the input. */
export class DecryptError extends Error {
  constructor(reason: string) {
    super(`decrypt failed: ${reason}`);
    this.name = "DecryptError";
  }
}

// ---------------------------------------------------------------------------
// Key loading
// ---------------------------------------------------------------------------

let cachedKey: Buffer | null = null;
let warnedFileMode = false;

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

function decodeKeyText(text: string, source: string): Buffer {
  const s = text.trim();
  if (s === "") throw new DataKeyInvalidError(`${source} is empty`);
  let key: Buffer;
  if (B64_RE.test(s)) key = Buffer.from(s, "base64");
  else if (B64URL_RE.test(s)) key = Buffer.from(s, "base64url");
  else throw new DataKeyInvalidError(`${source} is not base64 or base64url`);
  if (key.length !== KEY_BYTES) {
    throw new DataKeyInvalidError(
      `${source} decodes to ${key.length} bytes, expected ${KEY_BYTES}`
    );
  }
  return key;
}

function readKeyFile(file: string): Buffer {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch {
    throw new DataKeyInvalidError("TOKEN_ENCRYPTION_KEY_FILE cannot be read");
  }
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0 && !warnedFileMode) {
      warnedFileMode = true;
      log.warn("data_key_file_mode", {
        mode: mode.toString(8).padStart(3, "0"),
        hint: "TOKEN_ENCRYPTION_KEY_FILE is group/world readable; run: chmod 600 <file>",
      });
    }
  } catch {
    // stat failed after a successful read; the mode check is best effort.
  }
  if (raw.length === KEY_BYTES) return Buffer.from(raw);
  return decodeKeyText(raw.toString("utf8"), "TOKEN_ENCRYPTION_KEY_FILE");
}

/**
 * Returns the 32-byte data key, loading and validating it on first use.
 * Reads process.env directly (not lib/env) so it has no Plaid env dependency
 * and so lib/env stays import-safe without a key; only boot enforces it.
 */
export function loadDataKey(): Buffer {
  if (cachedKey) return cachedKey;
  const inline = process.env.TOKEN_ENCRYPTION_KEY;
  const file = process.env.TOKEN_ENCRYPTION_KEY_FILE;
  let key: Buffer;
  if (inline && inline.trim() !== "") {
    key = decodeKeyText(inline, "TOKEN_ENCRYPTION_KEY");
  } else if (file && file.trim() !== "") {
    key = readKeyFile(file.trim());
  } else {
    throw new DataKeyMissingError();
  }
  cachedKey = key;
  return key;
}

/** Test hook: forget the cached key (and the one-time file-mode warning). */
export function resetDataKeyCache(): void {
  cachedKey = null;
  warnedFileMode = false;
}

/** Key ring by ciphertext version. Rotation adds `2: nextKey` here. */
function keyRing(): Record<number, Buffer> {
  return { [CURRENT_VERSION]: loadDataKey() };
}

// ---------------------------------------------------------------------------
// AES-256-GCM
// ---------------------------------------------------------------------------

const WIRE_RE = /^v(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/;

/**
 * Encrypts `plaintext` under the current key with `aad` bound into the tag.
 * Returns `v1.<iv>.<tag>.<ct>` (base64url segments). Fresh random IV per call.
 */
export function encrypt(plaintext: string, aad: string): string {
  const key = keyRing()[CURRENT_VERSION];
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    `v${CURRENT_VERSION}`,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

/**
 * Decrypts a value produced by {@link encrypt} with the same `aad`.
 * Throws {@link DecryptError} on malformed input, unknown key version, or
 * authentication failure (wrong key, wrong AAD, tampered bytes).
 */
export function decrypt(ciphertext: string, aad: string): string {
  const m = WIRE_RE.exec(ciphertext);
  if (!m) throw new DecryptError("malformed ciphertext");
  const version = Number(m[1]);
  const key = keyRing()[version];
  if (!key) throw new DecryptError("unknown key version");

  const iv = Buffer.from(m[2], "base64url");
  const tag = Buffer.from(m[3], "base64url");
  const ct = Buffer.from(m[4], "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptError("malformed ciphertext");
  }

  try {
    const decipher = createDecipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    throw new DecryptError("authentication failed");
  }
}

/** True when `value` carries the versioned ciphertext prefix (`v1.` ...). */
export function isEncrypted(value: string): boolean {
  return /^v\d+\./.test(value);
}

// ---------------------------------------------------------------------------
// Small helpers used by auth / cron / webhook code
// ---------------------------------------------------------------------------

/** Constant-time string equality; does not short-circuit on length mismatch. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Burn a comparison of the same cost before returning false.
    timingSafeEqual(ab, Buffer.alloc(ab.length));
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** `bytes` random bytes as base64url (32 bytes -> 43 chars). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
