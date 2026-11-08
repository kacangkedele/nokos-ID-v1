// src/providers/registry.js — registry adapter per provider_code
//
// Menghubungkan kode adapter dengan konfigurasi di tabel providers.
// Adapter baru cukup didaftarkan di ADAPTERS map; tidak perlu ubah kode lain.
//
// getAdapter(env, providerCode): return instance adapter yang sudah ter-config.
//   - Bila provider_code tidak terdaftar → lempar error.
//   - Bila provider tidak aktif → lempar error (kecuali admin memaksa via opts.force).

import { first } from "../db.js";
import { ProviderError } from "./base.js";
import { RuangOTPAdapter } from "./ruangotp.js";
import { KirimKodeAdapter } from "./kirimkode.js";

// Map: provider_code → Adapter class.
// Tambahkan provider baru di sini (beserta file adapter-nya).
const ADAPTERS = {
  ruangotp: RuangOTPAdapter,
  kirimkode: KirimKodeAdapter,
  // Contoh untuk provider masa depan:
  // sms_activate: SmsActivateAdapter,
};

/** List kode provider yang didukung sistem. */
export function supportedProviders() {
  return Object.keys(ADAPTERS);
}

/**
 * Ambil konfigurasi provider dari DB + parse configuration JSON.
 */
export async function getProviderConfig(db, providerCodeOrId) {
  let row;
  if (typeof providerCodeOrId === "number" || /^\d+$/.test(String(providerCodeOrId))) {
    row = await first(db, `SELECT * FROM providers WHERE id = ?`, [Number(providerCodeOrId)]);
  } else {
    row = await first(db, `SELECT * FROM providers WHERE provider_code = ?`, [String(providerCodeOrId)]);
  }
  if (!row) {
    throw new ProviderError(`Provider '${providerCodeOrId}' tidak ditemukan di DB`, { code: "PROVIDER_NOT_FOUND" });
  }
  let configuration = {};
  try { configuration = JSON.parse(row.configuration || "{}"); } catch {}
  return { ...row, configuration };
}

/**
 * Buat instance adapter untuk provider.
 * @param {Object} env - Cloudflare env
 * @param {string|number} providerCodeOrId
 * @param {Object} [opts] - { force: true } untuk bypass status check (admin only)
 * @returns {BaseAdapter}
 */
export async function getAdapter(env, providerCodeOrId, opts = {}) {
  const config = await getProviderConfig(env.DB, providerCodeOrId);
  const AdapterClass = ADAPTERS[config.provider_code];
  if (!AdapterClass) {
    throw new ProviderError(
      `Adapter untuk provider '${config.provider_code}' belum terdaftar di registry. Tambahkan di src/providers/registry.js ADAPTERS map.`,
      { code: "ADAPTER_NOT_REGISTERED", providerCode: config.provider_code },
    );
  }
  if (config.status !== "active" && !opts.force) {
    throw new ProviderError(
      `Provider '${config.provider_name}' (${config.provider_code}) berstatus '${config.status}'. ` +
        `Aktifkan via panel admin setelah test koneksi berhasil.`,
      { code: "PROVIDER_INACTIVE", providerCode: config.provider_code },
    );
  }
  return new AdapterClass(config, env);
}

/**
 * Ambil adapter default (is_default=1 atau priority terendah yang aktif).
 */
export async function getDefaultAdapter(env) {
  const row = await first(
    env.DB,
    `SELECT provider_code FROM providers WHERE status='active' ORDER BY is_default DESC, priority ASC LIMIT 1`,
  );
  if (!row) {
    throw new ProviderError("Tidak ada provider aktif. Aktifkan minimal 1 provider via panel admin.", {
      code: "NO_ACTIVE_PROVIDER",
    });
  }
  return getAdapter(env, row.provider_code);
}

/**
 * Ambil daftar provider aktif (untuk pilihan user di katalog).
 */
export async function listActiveProviders(db) {
  const rows = await db
    .prepare(`SELECT id, provider_code, provider_name, priority, is_default, markup_percent, last_test_ok
                FROM providers WHERE status='active' ORDER BY priority ASC, is_default DESC`)
    .all();
  return rows.results || [];
}
