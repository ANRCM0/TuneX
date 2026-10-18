/**
 * Fernet token generation, byte-compatible with the backend's `fernetService`
 * (`packages/shared/src/fernet.ts`) and with the Python reference implementation
 * (`relayx-analysis/relayx_license_server.py` → `fernet_encrypt`, and
 * `relayx-analysis/forge_license.py` → `fernet_encrypt` / `fernet_decrypt`).
 *
 * Token layout (Fernet spec):
 *
 *   token = base64url( 0x80 || time(8B BE) || IV(16B) || AES-128-CBC(ct) || HMAC-SHA256(32B) )
 *   signing key = secret[0:16]   encryption key = secret[16:32]
 *   HMAC input  = 0x80 || time || IV || ct
 *
 * Implemented with `node:crypto` only — no `cryptography`/`fernet` dependency needed.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 0x80;
const IV_LENGTH = 16;
const MAC_LENGTH = 32;
const HMAC_INPUT_HEADER_LENGTH = 1 + 8; // version byte + 8-byte big-endian timestamp

/** urlsafe base64 (padded by default, matching Python's `base64.urlsafe_b64encode`). */
export function urlSafeBase64Encode(data: Uint8Array, padded = true): string {
  const urlSafe = Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return padded ? urlSafe : urlSafe.replace(/=+$/, "");
}

/** Tolerant urlsafe base64 decode — accepts standard `+/` alphabet and missing padding. */
export function urlSafeBase64Decode(value: string): Buffer {
  return Buffer.from(value.trim().replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeSecret(secretBase64: string): Buffer {
  const key = urlSafeBase64Decode(secretBase64);
  if (key.length !== 32) {
    throw new Error(`Fernet secret 必须解码为 32 字节，实际 ${key.length}`);
  }
  return key;
}

export interface FernetEncryptOptions {
  /** Unix seconds placed in the token; defaults to now. */
  timestamp?: number;
  /** 16-byte IV; defaults to a random one (only pin it in tests). */
  iv?: Uint8Array;
}

/** Encrypt `plaintext` into a RelayX-compatible Fernet token. */
export function fernetEncrypt(
  secretBase64: string,
  plaintext: Uint8Array,
  options: FernetEncryptOptions = {},
): string {
  const key = decodeSecret(secretBase64);
  const signingKey = key.subarray(0, 16);
  const encryptionKey = key.subarray(16, 32);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const iv = options.iv ?? randomBytes(IV_LENGTH);
  if (iv.length !== IV_LENGTH) {
    throw new Error(`IV 必须为 ${IV_LENGTH} 字节`);
  }

  // PKCS#7: 1..16 padding bytes, each equal to the padding length.
  const paddingLength = IV_LENGTH - (plaintext.length % IV_LENGTH);
  const padded = Buffer.alloc(plaintext.length + paddingLength, paddingLength);
  Buffer.from(plaintext).copy(padded);

  const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv);
  // We pad manually (PKCS#7 above), so disable Node's implicit padding.
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);

  const header = Buffer.alloc(HMAC_INPUT_HEADER_LENGTH);
  header.writeUInt8(VERSION, 0);
  header.writeBigUInt64BE(BigInt(timestamp), 1);

  const body = Buffer.concat([header, iv, ciphertext]);
  const mac = createHmac("sha256", signingKey).update(body).digest();
  return urlSafeBase64Encode(Buffer.concat([body, mac]));
}

/**
 * Decrypt a Fernet token. The HTTP endpoints never need this — it exists so tests and
 * operators can verify what the server emitted (the Python `forge_license.py` tool
 * carries the same helper for its `--selftest`).
 */
export function fernetDecrypt(secretBase64: string, token: string): Buffer {
  const key = decodeSecret(secretBase64);
  const signingKey = key.subarray(0, 16);
  const encryptionKey = key.subarray(16, 32);

  const raw = urlSafeBase64Decode(token);
  if (raw.length < HMAC_INPUT_HEADER_LENGTH + IV_LENGTH + MAC_LENGTH + IV_LENGTH) {
    throw new Error("Fernet 令牌长度非法");
  }
  if (raw[0] !== VERSION) {
    throw new Error(`Fernet 版本字节非法: 0x${raw[0].toString(16)}`);
  }

  const body = raw.subarray(0, raw.length - MAC_LENGTH);
  const mac = raw.subarray(raw.length - MAC_LENGTH);
  const expectedMac = createHmac("sha256", signingKey).update(body).digest();
  if (expectedMac.length !== mac.length || !timingSafeEqual(expectedMac, mac)) {
    throw new Error("Fernet HMAC 校验失败");
  }

  const iv = body.subarray(HMAC_INPUT_HEADER_LENGTH, HMAC_INPUT_HEADER_LENGTH + IV_LENGTH);
  const ciphertext = body.subarray(HMAC_INPUT_HEADER_LENGTH + IV_LENGTH);
  const decipher = createDecipheriv("aes-128-cbc", encryptionKey, iv);
  // The plaintext is padded by the sender; we strip it manually below.
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  const paddingLength = padded[padded.length - 1];
  if (paddingLength < 1 || paddingLength > IV_LENGTH) {
    throw new Error("Fernet 填充非法");
  }
  return padded.subarray(0, padded.length - paddingLength);
}
