-- =====================================================================
-- Nokos.ID V2 — Migration 0003: Multi-Provider OTP Management
-- Brand: Angga Official
--
-- Tujuan:
--   - Mendukung beberapa provider OTP (RuangOTP, KirimKode, dst).
--   - Konfigurasi provider di-DB (BUKAN API key — hanya referensi secret).
--   - Routing cerdas: manual / cheapest / priority / availability.
--   - Satu saldo internal Nokos.ID untuk semua provider (Unified Wallet).
--   - Audit penuh setiap panggilan provider.
--
-- Aturan keamanan (dari master prompt BAGIAN 17):
--   - API Key TIDAK disimpan di kolom DB biasa — hanya nama secret (Cloudflare Secret).
--   - Provider tidak bisa diaktifkan sebelum test koneksi berhasil.
--   - Setiap order mencatat provider_id + provider_order_id (anti double purchase).
--   - provider_logs mencatat response tanpa rahasia.
-- =====================================================================

-- ---- providers -----------------------------------------------------
-- Konfigurasi provider. API key disimpan via Cloudflare Secrets dengan
-- nama konvensi: PROVIDER_<CODE>_API_KEY (mis. PROVIDER_RUANGOTP_API_KEY).
-- Kolom api_key_secret_name hanya menyimpan NAMA secret, BUKAN nilainya.
CREATE TABLE IF NOT EXISTS providers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_code       TEXT NOT NULL UNIQUE,                -- 'ruangotp', 'kirimkode', dst
  provider_name       TEXT NOT NULL,                        -- tampilan: "RuangOTP"
  base_url            TEXT NOT NULL,                        -- https://ruangotp.io/api
  auth_method         TEXT NOT NULL DEFAULT 'bearer'
                      CHECK(auth_method IN ('bearer','query','header')),
  auth_header_name    TEXT,                                 -- bila auth_method='header'
  api_key_secret_name TEXT NOT NULL,                        -- nama Cloudflare Secret (BUKAN nilai)
  auth_in_query_param TEXT,                                -- bila auth_method='query', nama param
  status              TEXT NOT NULL DEFAULT 'inactive'
                      CHECK(status IN ('inactive','active','degraded','disabled')),
  priority            INTEGER NOT NULL DEFAULT 100,        -- 1 = tertinggi
  is_default          INTEGER NOT NULL DEFAULT 0,
  markup_percent      INTEGER NOT NULL DEFAULT 15,
  timeout_ms          INTEGER NOT NULL DEFAULT 10000,
  max_retries         INTEGER NOT NULL DEFAULT 2,
  configuration       TEXT,                                -- JSON path map tambahan
  last_test_at        INTEGER,
  last_test_ok        INTEGER,
  last_balance_cents  INTEGER,                              -- saldo provider bila API dukung
  last_balance_at     INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- ---- provider_services --------------------------------------------
-- Cache layanan per (provider, country). Di-refresh dari adapter.
CREATE TABLE IF NOT EXISTS provider_services (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id   INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  service_code  TEXT NOT NULL,                              -- id layanan provider
  country_code  TEXT,                                       -- id negara provider
  service_name  TEXT,
  operator_code TEXT,
  is_available  INTEGER NOT NULL DEFAULT 1,
  cached_price_cents INTEGER,                               -- harga provider (cent IDR)
  cached_at     INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE(provider_id, service_code, country_code, operator_code)
);

-- ---- provider_logs ------------------------------------------------
-- Audit setiap panggilan API provider. TIDAK boleh berisi api_key.
CREATE TABLE IF NOT EXISTS provider_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id       INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  otp_order_id      TEXT,                                   -- relasi ke otp_orders (bila ada)
  request_reference TEXT,                                   -- id internal untuk trace
  action            TEXT NOT NULL,                          -- getCountries/getServices/getNumber/getStatus/setStatus/getBalance
  http_status       INTEGER,
  error_code        TEXT,
  duration_ms       INTEGER,
  redacted_meta     TEXT,                                   -- JSON: method, path, params (no api_key)
  redacted_response TEXT,                                   -- JSON response dipotong (no secret)
  success           INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

-- ---- otp_orders: tambah kolom provider_id ------------------------
-- (otp_orders sudah ada dari migration 0001; kita ADD COLUMN.)
-- provider_id = NULL untuk order lama (kompatibilitas mundur).
-- provider_order_id sudah ada di schema 0001.
ALTER TABLE otp_orders ADD COLUMN provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL;

-- Index untuk multi-provider
CREATE INDEX IF NOT EXISTS idx_providers_status      ON providers(status, priority);
CREATE INDEX IF NOT EXISTS idx_providers_default     ON providers(is_default);
CREATE INDEX IF NOT EXISTS idx_provider_services_prov ON provider_services(provider_id, is_available);
CREATE INDEX IF NOT EXISTS idx_provider_services_lookup ON provider_services(service_code, country_code);
CREATE INDEX IF NOT EXISTS idx_provider_logs_prov    ON provider_logs(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_logs_order   ON provider_logs(otp_order_id);
CREATE INDEX IF NOT EXISTS idx_provider_logs_action  ON provider_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_orders_provider  ON otp_orders(provider_id, created_at DESC);

-- ---- Seed provider default: RuangOTP ------------------------------
-- Status 'inactive' — admin WAJIB isi api_key_secret_name + test koneksi
-- sebelum aktivasi. Lihat README bagian "Multi-Provider".
INSERT OR IGNORE INTO providers (
  provider_code, provider_name, base_url, auth_method, api_key_secret_name,
  status, priority, is_default, markup_percent, timeout_ms, max_retries,
  configuration, created_at, updated_at
) VALUES (
  'ruangotp',
  'RuangOTP',
  'https://ruangotp.io/api',
  'bearer',
  'RUANGOTP_API_KEY',
  'inactive',
  1,
  1,
  15,
  10000,
  2,
  '{"paths":{"countries":"/country-v2/list","services":"/service-v2/list","prices":"/price-v2/list","getNumber":"/order-v2/get-number","getStatus":"/order-v2/get-status","setStatus":"/order-v2/set-status","orderHistory":"/order-v2/history","getBalance":"/balance-v2"}}',
  strftime('%s','now'),
  strftime('%s','now')
);

-- Seed placeholder KirimKode (INACTIVE — wajib verifikasi dashboard)
INSERT OR IGNORE INTO providers (
  provider_code, provider_name, base_url, auth_method, api_key_secret_name,
  status, priority, is_default, markup_percent, timeout_ms, max_retries,
  configuration, created_at, updated_at
) VALUES (
  'kirimkode',
  'KirimKode',
  'PASTE_KIRIMKODE_BASE_URL',
  'bearer',
  'KIRIMKODE_API_KEY',
  'inactive',
  2,
  0,
  15,
  10000,
  2,
  '{"paths":{"countries":"PASTE_PATH","services":"PASTE_PATH","prices":"PASTE_PATH","getNumber":"PASTE_PATH","getStatus":"PASTE_PATH","setStatus":"PASTE_PATH","orderHistory":"PASTE_PATH","getBalance":"PASTE_PATH"}}',
  strftime('%s','now'),
  strftime('%s','now')
);

-- Catatan: provider KirimKode TIDAK bisa diaktifkan sebelum:
--   1. base_url diisi (dari dashboard KirimKode)
--   2. path map diverifikasi (lihat PROVIDER_VERIFY.md)
--   3. api_key_secret_name dikonfigurasi via Cloudflare Secret KIRIMKODE_API_KEY
--   4. Test koneksi berhasil via /api/admin/providers/:id/test
