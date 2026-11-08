// src/validation.js — validasi input server-side
// Tidak ada dependency; pola whitelist + range check.

import { isEmail, isUsername, normalizeEmail } from "./utils.js";

const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;
const USERNAME_MIN = 3;
const USERNAME_MAX = 30;
const AMOUNT_MAX = 5_000_000_00; // Rp 5.000.000 per deposit (default config)

/** Throw ValidationError bila gagal. */
export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

function fail(msg, field) {
  throw new ValidationError(msg, field);
}

export function validateRegister({ username, email, password }) {
  if (!isUsername(username)) {
    fail("Username 3-30 karakter alfanumerik, titik, strip, underscore.", "username");
  }
  if (!isEmail(email)) fail("Format email tidak valid.", "email");
  if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    fail(`Password minimal ${PASSWORD_MIN} karakter dan maksimal ${PASSWORD_MAX}.`, "password");
  }
  // cek kebocoran password umum
  const weak = ["password", "12345678", "qwerty123", "iloveyou", "password123"];
  if (weak.includes(password.toLowerCase())) fail("Password terlalu umum.", "password");
  return {
    username: username.trim(),
    email: normalizeEmail(email),
    password,
  };
}

export function validateLogin({ email, password }) {
  if (!isEmail(email)) fail("Email tidak valid.", "email");
  if (typeof password !== "string" || !password) fail("Password wajib diisi.", "password");
  return { email: normalizeEmail(email), password };
}

/** Validasi nominal deposit (cents). */
export function validateDepositAmount(amount, settings) {
  const n = Number(amount);
  if (!Number.isInteger(n)) fail("Nominal harus berupa angka bulat.", "amount");
  const min = Number(settings?.qris_min_amount_cents || 10000);
  const max = Number(settings?.qris_max_amount_cents || AMOUNT_MAX);
  if (n < min) fail(`Nominal minimal Rp${min / 100}.`, "amount");
  if (n > max) fail(`Nominal maksimal Rp${max / 100}.`, "amount");
  return n;
}

/** Validasi MIME bukti pembayaran (whitelist). */
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PROOF_SIZE = 5 * 1024 * 1024; // 5 MB

export function validateProofFile(file) {
  if (!file) fail("File bukti wajib diunggah.", "proof");
  if (!ALLOWED_MIME.has(file.type)) {
    fail("Format file harus JPG, PNG, atau WebP.", "proof");
  }
  if (file.size > MAX_PROOF_SIZE) fail("Ukuran file maksimal 5 MB.", "proof");
  return file;
}

/** Magic bytes untuk verifikasi konten file (bukan hanya header MIME). */
export function detectMime(bytes) {
  if (bytes.length < 12) return "unknown";
  if (bytes[0] === 0xff && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return "unknown";
}

/** Validasi idempotency key dari klien (UUID-like atau hex). */
export function validateIdempotencyKey(key) {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  if (/^[a-f0-9-]{16,64}$/i.test(trimmed)) return trimmed;
  return null;
}

/** Sanitize string bebas (untuk alasan penolakan, deskripsi). */
export function sanitizeText(s, maxLen = 500) {
  if (typeof s !== "string") return "";
  return s.slice(0, maxLen).replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/** Validasi 2FA 6-digit code. */
export function validateTOTPCode(code) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    fail("Kode 2FA harus 6 digit.", "code");
  }
  return code;
}

/** Validasi recovery code format XXXX-XXXX-XXXX-XXXX. */
export function validateRecoveryCode(code) {
  if (typeof code !== "string" || !/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/i.test(code)) {
    fail("Format recovery code tidak valid.", "code");
  }
  return code.toUpperCase();
}
