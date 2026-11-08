// src/security.js — kriptografi: hashing password, enkripsi TOTP, JWT.
// Cloudflare Workers mendukung Web Crypto API (SubtleCrypto).
//
// Password hashing: PBKDF2-SHA256, 210.000 iterasi, salt 16 byte acak.
//   (Argon2id tidak native di Workers; PBKDF2 ini setara OWASP 2023.)
//
// TOTP secret admin: AES-GCM 256-bit, kunci dari ENCRYPTION_KEY.
//
// Session: signed cookie berisi session id acak (bukan JWT user info,
//   untuk memungkinkan revocation server-side).

const PBKDF2_ITER = 210000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEYLEN = 32;
const ENC_KEY_BYTES = 32;

/** Base64 untuk Uint8Array. */
function b64encode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Base64 ke Uint8Array. */
function b64decode(str) {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

/** Hex string. */
function hex(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash password. Format: $pbkdf2-sha256$<iter>$<salt_b64>$<hash_b64>
 */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const key = await deriveKey(password, salt, PBKDF2_ITER);
  const hash = await crypto.subtle.exportKey("raw", key);
  return `$pbkdf2-sha256$${PBKDF2_ITER}$${b64encode(salt)}$${b64encode(hash)}`;
}

async function deriveKey(password, salt, iter) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    baseKey,
    { name: "HMAC", hash: "SHA-256", length: PBKDF2_KEYLEN * 8 },
    true,
    ["sign"],
  );
}

/**
 * Verifikasi password terhadap hash. Constant-time comparison.
 */
export async function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[1] !== "pbkdf2-sha256") return false;
  const iter = parseInt(parts[2], 10);
  const salt = b64decode(parts[3]);
  const expected = b64decode(parts[4]);
  const key = await deriveKey(password, salt, iter);
  const actual = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return constantTimeEqual(actual, expected);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Derive kunci enkripsi 256-bit dari ENCRYPTION_KEY (string).
 * Pengguna mengisi ENCRYPTION_KEY bebas; kita derive via SHA-256.
 */
async function getEncKey(env) {
  const raw = env.ENCRYPTION_KEY || "default-insecure-please-set-ENCRYPTION_KEY";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Enkripsi plaintext (TOTP secret) → { ct, iv } base64.
 */
export async function encryptSecret(plaintext, env) {
  const key = await getEncKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ct: b64encode(ct), iv: b64encode(iv) };
}

/**
 * Dekripsi. Throw bila kunci salah / data rusak.
 */
export async function decryptSecret(encObj, env) {
  const key = await getEncKey(env);
  const iv = b64decode(encObj.iv);
  const ct = b64decode(encObj.ct);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/** Hash recovery code (SHA-256 hex). Tidak simpan plaintext. */
export async function hashRecoveryCode(code) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return hex(h);
}

/** HMAC-SHA256 untuk verifikasi signature webhook provider. */
export async function hmacSHA256(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return hex(sig);
}

/** Compare hex signature constant-time (toleran case). */
export function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la.length !== lb.length) return false;
  let diff = 0;
  for (let i = 0; i < la.length; i++) diff |= la.charCodeAt(i) ^ lb.charCodeAt(i);
  return diff === 0;
}
