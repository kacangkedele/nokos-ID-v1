-- =====================================================================
-- Nokos.ID V2 — Migration 0002: Indexes & seed admin pertama
-- =====================================================================

-- Index untuk performa query umum
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user      ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_ref        ON wallet_transactions(reference_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_idem       ON wallet_transactions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_type       ON wallet_transactions(transaction_type, status);

CREATE INDEX IF NOT EXISTS idx_deposits_user        ON deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_status      ON deposits(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_proof       ON deposits(payment_proof_key);

CREATE INDEX IF NOT EXISTS idx_otp_orders_user      ON otp_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_orders_status   ON otp_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_orders_provider ON otp_orders(provider_order_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user       ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires    ON sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_user          ON wallet_audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_admin         ON wallet_audit_logs(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action        ON wallet_audit_logs(action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_user       ON security_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_type       ON security_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notif_user          ON notifications(user_id, created_at DESC, is_read);

CREATE INDEX IF NOT EXISTS idx_provider_resp_order ON provider_responses(otp_order_id, created_at DESC);

-- =====================================================================
-- SEED: Admin pertama (default). WAJIB ganti password setelah deploy!
-- Password default: "ChangeMe!2026" (PBKDF2-SHA256, 210000 iterasi, salt acak)
--   Hash di bawah dibuat untuk dokumen contoh — GANTI melalui script
--   `node scripts/create-admin.js` atau `UPDATE users SET password_hash=...`
--   setelah menjalankan migration. Lihat README bagian "Membuat Admin".
-- =====================================================================
INSERT OR IGNORE INTO users (id, username, email, password_hash, role, status, email_verified, created_at, updated_at)
VALUES (
  1,
  'superadmin',
  'admin@nokos.id',
  '$pbkdf2-sha256$210000$Y2hhbmdlLW1lLXNhbHQA$PLACEHOLDER_RUN_CREATE_ADMIN_SCRIPT',
  'super_admin',
  'active',
  1,
  strftime('%s','now'),
  strftime('%s','now')
);

INSERT OR IGNORE INTO admin_users (user_id, role, created_at)
VALUES (1, 'super_admin', strftime('%s','now'));

-- Wallet untuk admin (tidak dipakai transaksi, tapi konsistensi FK)
INSERT OR IGNORE INTO wallets (user_id, balance, currency, created_at, updated_at)
VALUES (1, 0, 'IDR', strftime('%s','now'), strftime('%s','now'));

-- Catatan: 2FA BELUM di-setup untuk admin seed. Setelah login pertama,
-- admin WAJIB setup 2FA via /admin/2fa-setup.html sebelum bisa approve deposit.
