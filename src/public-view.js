// src/public-view.js — Hidden Provider System
//
// Master prompt "Hidden Provider System": identitas provider asli (RuangOTP,
// KirimKode, dll) TIDAK boleh muncul di:
//   - respons API publik (/api/otp/*)
//   - notifikasi user
//   - pesan error yang ditampilkan ke user
//   - URL, HTML, JavaScript, source map, log yang bisa diakses user
//
// Modul ini menyediakan:
//   - maskProvider(p)        → { id, display_name } saja
//   - maskProviderList(list) → array of masked
//   - sanitizeForUser(text)  → strip referensi provider dari string
//
// Admin API (/api/admin/providers/*) TIDAK memakai masking — di-protect RBAC.
//
// Aturan: jangan pernah return provider_code, provider_name, base_url,
// api_key_secret_name, configuration.paths, atau provider_order_id ke user.

import { first } from "./db.js";

const PROVIDER_NAME_LEAKS = [
  "ruangotp", "ruang otp", "ruang-otp",
  "kirimkode", "kirim kode", "kirim-kode",
  "sms-activate", "smsactivate", "5sim", "sms-activate.org",
  "activate", "adapter",
];

const LEAK_REGEXES = [
  /provider\s*['"]?[a-z0-9_\-]+['"]?/gi,
  /adapter\s*['"]?[a-z0-9_\-]+['"]?/gi,
  /\b(ruangotp|kirimkode|sms[\-\s]?activate|5sim)\b/gi,
  /\bapi[_\s]?key\b/gi,
  /\bsecret\b/gi,
  /\bendpoint\b/gi,
  /\bbase[_\s]?url\b/gi,
  // Kode error provider yang bisa mengungkap identitas (sms-activate style)
  /\b(bad[_\s]?key|wrong[_\s]?key|no[_\s]?numbers|no[_\s]?balance|wrong[_\s]?service|bad[_\s]?action)\b/gi,
];

/**
 * Masking satu provider untuk tampilan publik.
 * Hanya return { id, display_name } — TIDAK ada provider_code/name/url/secret.
 */
export function maskProvider(p) {
  if (!p) return null;
  return {
    id: p.id,
    display_name: p.display_name || (p.is_default ? "Nokos.ID Server" : `Server ${p.id}`),
  };
}

/**
 * Masking list provider.
 */
export function maskProviderList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(maskProvider);
}

/**
 * Ambil display_name provider by id (untuk response order dll).
 */
export async function getDisplayName(db, providerId) {
  if (!providerId) return null;
  const row = await first(db, `SELECT display_name, is_default, id FROM providers WHERE id = ?`, [providerId]);
  if (!row) return null;
  return row.display_name || (row.is_default ? "Nokos.ID Server" : `Server ${row.id}`);
}

/**
 * Sanitasi string sebelum ditampilkan ke user.
 * Ganti semua referensi provider asli dengan "Nokos.ID Server".
 *
 * Dipakai untuk:
 *   - failure_reason yang di-return ke user
 *   - body notifikasi
 *   - pesan error API publik
 *
 * Catatan: raw error tetap dicatat internal di audit_log / provider_logs.
 */
export function sanitizeForUser(text) {
  if (text === null || text === undefined) return text;
  let out = String(text);
  for (const re of LEAK_REGEXES) {
    out = out.replace(re, "Nokos.ID Server");
  }
  // Bersihkan double space / kapitalisasi aneh hasil replace
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

/**
 * Cek apakah string mengandung leak provider (untuk test/assertion).
 */
export function containsProviderLeak(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return PROVIDER_NAME_LEAKS.some((name) => lower.includes(name));
}

/**
 * Masking response order untuk user. Strip provider_order_id, provider_code.
 */
export function maskOrderForUser(order) {
  if (!order) return null;
  const { provider_order_id, provider_code, provider_name, provider_id, ...rest } = order;
  // display_name di-attach terpisah (bila ada)
  return {
    ...rest,
    server_name: order.server_name || (order.provider_id ? `Server ${order.provider_id}` : "Nokos.ID Server"),
  };
}
