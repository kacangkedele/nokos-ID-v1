// src/utils.js — utilitas umum Nokos.ID V2
// Brand: Angga Official

export const ID_CURRENCY = "IDR";

/** Waktu sekarang dalam detik (Unix epoch). */
export function now() {
  return Math.floor(Date.now() / 1000);
}

/** Random hex string panjang n bytes (default 32). */
export function randomHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * ULID-like (Crockford base32, 26 char, sortable waktu).
 * Dipakai untuk id deposit dan otp_orders agar tidak mudah ditebak.
 */
export function ulid() {
  const enc = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const time = Date.now();
  let ts = "";
  let t = time;
  for (let i = 9; i >= 0; i--) {
    ts = enc[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  let randPart = "";
  for (let i = 0; i < 10; i++) randPart += enc[rand[i] % 32];
  return ts + randPart;
}

/** Kode deposit yang ramah dibaca: DEP-XXXXXXXX */
export function depositCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[arr[i] % chars.length];
  return "DEP-" + s;
}

/** Format Rupiah dari integer cents. */
export function formatIDR(cents) {
  const rp = Math.floor(cents / 100);
  return "Rp" + rp.toLocaleString("id-ID");
}

/** Standard JSON response. */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

/** CORS hanya untuk same-origin (API dipanggil dari domain sendiri). */
export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "same-origin",
    "Vary": "Origin",
  };
}

/** Baca body JSON dengan aman. */
export async function readJSON(req) {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null; // sinyal parse gagal
  }
}

/** Escape HTML untuk mencegah XSS saat render server-side. */
export function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Validate email format sederhana. */
export function isEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

/** Username: 3-30 char alfanumerik + _ . - */
export function isUsername(s) {
  return typeof s === "string" && /^[a-zA-Z0-9_.-]{3,30}$/.test(s);
}

/** Trim + lower email. */
export function normalizeEmail(s) {
  return String(s ?? "").trim().toLowerCase();
}
