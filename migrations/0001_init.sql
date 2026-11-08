-- =====================================================================
-- Nokos.ID V2 — Migration 0001: Skema lengkap (Wallet Ledger, Deposit,
-- Multi-admin 2FA, OTP, Sessions, Audit, Idempotency, Notifications)
-- Brand: Angga Official
-- Target: Cloudflare D1 (SQLite)
-- Mata uang: IDR (integer cents). balance = balance_cents.
-- =====================================================================

-- ---- users ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,              -- Argon2id (Web Crypto PBKDF2 fallback)
  role          TEXT NOT NULL DEFAULT 'user'
                CHECK(role IN ('user','super_admin','admin_deposit','admin_support','admin_ops')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK(status IN ('active','suspended','banned')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ---- wallets -------------------------------------------------------
-- Satu wallet per user. balance hanya diubah oleh trigger ledger.
CREATE TABLE IF NOT EXISTS wallets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance       INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  currency      TEXT NOT NULL DEFAULT 'IDR',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ---- wallet_transactions (LEDGER) ----------------------------------
-- Sumber kebenaran finansial. Append-only. Tidak pernah UPDATE/DELETE.
-- UNIQUE(user_id, idempotency_key) → anti double-credit & double-refund.
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference_id      TEXT,                 -- deposit.id / otp_orders.id / refund.id
  idempotency_key   TEXT,                 -- anti double-spending
  transaction_type  TEXT NOT NULL CHECK(transaction_type IN
                        ('deposit','order','refund','adjustment')),
  amount            INTEGER NOT NULL,      -- + untuk kredit, - untuk debit
  balance_before    INTEGER NOT NULL,
  balance_after     INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'completed'
                      CHECK(status IN ('pending','completed','failed','reversed')),
  description       TEXT,
  created_at        INTEGER NOT NULL,
  UNIQUE(user_id, idempotency_key)        -- idempotency enforced at DB level
);

-- ---- deposits (QRIS Manual) ---------------------------------------
CREATE TABLE IF NOT EXISTS deposits (
  id                  TEXT PRIMARY KEY,      -- ULID
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deposit_code        TEXT NOT NULL UNIQUE,  -- kode unik untuk verifikasi
  amount              INTEGER NOT NULL CHECK(amount > 0),
  payment_method      TEXT NOT NULL DEFAULT 'qris',
  payment_proof_key   TEXT,                  -- R2 object key
  payment_proof_mime  TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','approved','rejected','cancelled')),
  admin_id            INTEGER REFERENCES users(id),
  rejection_reason    TEXT,
  verified_at         INTEGER,
  ledger_id           INTEGER REFERENCES wallet_transactions(id),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- ---- admin_users (2FA admin) -------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role                        TEXT NOT NULL CHECK(role IN
                        ('super_admin','admin_deposit','admin_support','admin_ops')),
  two_factor_enabled          INTEGER NOT NULL DEFAULT 0,
  two_factor_secret_enc       TEXT,           -- AES-GCM encrypted TOTP secret (base64)
  two_factor_iv               TEXT,           -- initialization vector
  two_factor_setup_at         INTEGER,
  recovery_codes_hash         TEXT,           -- JSON array hash (bcrypt-style)
  recovery_codes_used         INTEGER NOT NULL DEFAULT 0,
  last_2fa_at                 INTEGER,
  created_at                  INTEGER NOT NULL
);

-- ---- otp_orders (pembelian nomor via RuangOTP) --------------------
CREATE TABLE IF NOT EXISTS otp_orders (
  id                  TEXT PRIMARY KEY,       -- ULID
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key     TEXT NOT NULL,
  country_id          INTEGER,
  service_id          TEXT,
  operator_id         TEXT,
  phone_number        TEXT,
  provider_order_id   TEXT,                   -- id dari RuangOTP
  cost_cents          INTEGER NOT NULL,       -- harga jual (dipotong dari saldo)
  provider_cost_cents INTEGER,                -- harga provider (audit)
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','active','completed','cancelled','expired','failed')),
  sms_text            TEXT,
  sms_received_at      INTEGER,
  expires_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  cancelled_at        INTEGER,
  failure_reason      TEXT,
  ledger_id           INTEGER REFERENCES wallet_transactions(id),
  refund_ledger_id    INTEGER REFERENCES wallet_transactions(id),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- ---- provider_responses (log mentah RuangOTP) ---------------------
CREATE TABLE IF NOT EXISTS provider_responses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  otp_order_id    TEXT REFERENCES otp_orders(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,              -- 'getNumber','getStatus','setStatus'
  request_meta    TEXT,                       -- JSON, TIDAK boleh berisi api_key
  response_raw    TEXT,                       -- JSON mentah dari provider
  http_status     INTEGER,
  created_at      INTEGER NOT NULL
);

-- ---- sessions -----------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,             -- random 32 byte (hex)
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    TEXT NOT NULL,                -- double-submit CSRF
  ip            TEXT,
  ua            TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

-- ---- idempotency records ------------------------------------------
-- Anti-replay & anti-double-spend. Cek sebelum eksekusi transaksi.
CREATE TABLE IF NOT EXISTS idempotency_records (
  key             TEXT PRIMARY KEY,            -- idempotency_key dari klien
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL,
  status_code     INTEGER,
  response_body   TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

-- ---- wallet_audit_logs -------------------------------------------
CREATE TABLE IF NOT EXISTS wallet_audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER,                      -- subjek
  admin_id      INTEGER,                      -- aktor (admin)
  action        TEXT NOT NULL,                -- 'deposit_approve','deposit_reject','refund','provider_call', dll
  reference_id  TEXT,
  details       TEXT,                         -- JSON; JANGAN simpan secret/api_key
  ip            TEXT,
  ua            TEXT,
  created_at    INTEGER NOT NULL
);

-- ---- security_events ---------------------------------------------
CREATE TABLE IF NOT EXISTS security_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER,
  event_type    TEXT NOT NULL,                 -- 'login_failed','2fa_failed','privilege_denied','rate_limit_hit', dll
  severity      TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warn','critical')),
  ip            TEXT,
  ua            TEXT,
  details       TEXT,
  created_at    INTEGER NOT NULL
);

-- ---- notifications -----------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,                 -- 'deposit_approved','deposit_rejected','otp_received','order_failed', dll
  title         TEXT NOT NULL,
  body          TEXT,
  is_read       INTEGER NOT NULL DEFAULT 0,
  reference_id  TEXT,
  created_at    INTEGER NOT NULL
);

-- ---- system_settings (QRIS config, harga markup, dll) ------------
CREATE TABLE IF NOT EXISTS system_settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_by    INTEGER REFERENCES users(id),
  updated_at    INTEGER NOT NULL
);

-- Default settings (operator edit via panel admin)
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES
  ('qris_merchant_name',    'Angga Official',           strftime('%s','now')),
  ('qris_image_path',       '/assets/qris-angga-official.png', strftime('%s','now')),
  ('qris_min_amount_cents', '10000',                    strftime('%s','now')),
  ('qris_max_amount_cents', '50000000',                 strftime('%s','now')),
  ('qris_preset_amounts',   '10000,25000,50000,100000,200000,500000', strftime('%s','now')),
  ('price_markup_percent',  '15',                       strftime('%s','now')),
  ('order_expiry_seconds',  '900',                      strftime('%s','now')),
  ('provider_enabled',      '1',                        strftime('%s','now'));

-- =====================================================================
-- TRIGGER: jaga wallets.balance konsisten dengan ledger.
-- Setiap INSERT ke wallet_transactions (status='completed') meng-update
-- balance wallet secara atomik. Ini adalah inti "immutable ledger".
-- =====================================================================
CREATE TRIGGER IF NOT EXISTS trg_ledger_balance
AFTER INSERT ON wallet_transactions
WHEN NEW.status = 'completed'
BEGIN
  UPDATE wallets
     SET balance = NEW.balance_after,
         updated_at = NEW.created_at
   WHERE user_id = NEW.user_id;
END;

-- =====================================================================
-- TRIGGER: cegah balance minus (defense in depth).
-- Selain CHECK constraint saat INSERT, trigger ini menolak update yang
-- menghasilkan balance < 0 (mis. dari race condition manual).
-- =====================================================================
CREATE TRIGGER IF NOT EXISTS trg_wallet_no_negative
BEFORE UPDATE OF balance ON wallets
WHEN NEW.balance < 0
BEGIN
  SELECT RAISE(ABORT, 'Saldo tidak boleh minus');
END;
