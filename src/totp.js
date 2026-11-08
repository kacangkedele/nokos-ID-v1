// src/totp.js — RFC 6238 TOTP (Time-based One-Time Password)
// Implementasi murni Web Crypto, tanpa dependency.
// Dipakai untuk 2FA admin.

const PERIOD = 30;
const DIGITS = 6;

function base32Decode(str) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = str.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 char: " + ch);
    bits += idx.toString(32).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

function base32Encode(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

/** Generate random TOTP secret (20 bytes = 160 bit, base32). */
export function generateTOTPSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return base32Encode(bytes);
}

/** otpauth:// URI untuk QR code setup. */
export function otpauthURI(secret, account, issuer = "Nokos.ID") {
  const q = encodeURIComponent(issuer);
  const a = encodeURIComponent(account);
  const s = encodeURIComponent(secret);
  return `otpauth://totp/${q}:${a}?secret=${s}&issuer=${q}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

async function hmacSHA1(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return new Uint8Array(sig);
}

function dynamicTruncation(hmac, digits) {
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/**
 * Generate TOTP untuk waktu tertentu (detik). Default waktu sekarang.
 * @param {string} secret base32
 * @param {number} [t] unix seconds
 * @returns {string} 6 digit
 */
export async function generateTOTP(secret, t = Math.floor(Date.now() / 1000)) {
  const keyBytes = base32Decode(secret);
  const counter = Math.floor(t / PERIOD);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  // counter 64-bit big-endian; JS number aman hingga 2^53
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const hmac = await hmacSHA1(keyBytes, new Uint8Array(msg));
  return dynamicTruncation(hmac, DIGITS);
}

/**
 * Verifikasi kode TOTP user. Menerima window ±1 period (30 detik)
 * untuk toleransi clock skew. Constant-time compare.
 */
export async function verifyTOTP(secret, code, t = Math.floor(Date.now() / 1000)) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  for (const offset of [-1, 0, 1]) {
    const expected = await generateTOTP(secret, t + offset * PERIOD);
    if (constantTimeStr(code, expected)) return true;
  }
  return false;
}

function constantTimeStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Generate 10 recovery codes (16 char base32, hyphen tiap 4). */
export function generateRecoveryCodes(count = 10) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, tanpa 0/1/8/9
  const codes = [];
  for (let i = 0; i < count; i++) {
    const arr = crypto.getRandomValues(new Uint8Array(16));
    let s = "";
    for (const b of arr) s += chars[b % chars.length];
    codes.push(s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16));
  }
  return codes;
}
