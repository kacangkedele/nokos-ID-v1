-- =====================================================================
-- Nokos.ID V2 — Migration 0004: Hidden Provider System
-- Brand: Angga Official
--
-- Tujuan:
--   Identitas provider asli (RuangOTP, KirimKode, dll) disembunyikan dari
--   user biasa. User hanya melihat display_name generik ("Nokos.ID Server",
--   "Server 1", "Server 2"). Admin tetap bisa lihat provider_code asli.
--
-- Implementasi:
--   - Kolom display_name di tabel providers (diisi admin, default otomatis).
--   - Backfill seed: is_default=1 → "Nokos.ID Server", else "Server <id>".
--   - Tidak mengubah provider_code (internal, untuk adapter registry).
--   - otp_orders.provider_id tetap dicatat (internal tracking).
-- =====================================================================

ALTER TABLE providers ADD COLUMN display_name TEXT;

-- Backfill display_name untuk provider existing
UPDATE providers
   SET display_name = CASE
     WHEN is_default = 1 THEN 'Nokos.ID Server'
     ELSE 'Server ' || id
   END
 WHERE display_name IS NULL;

-- Pastikan setiap provider baru selalu punya display_name (via trigger)
CREATE TRIGGER IF NOT EXISTS trg_providers_display_name
AFTER INSERT ON providers
WHEN NEW.display_name IS NULL
BEGIN
  UPDATE providers
     SET display_name = CASE
       WHEN NEW.is_default = 1 THEN 'Nokos.ID Server'
       ELSE 'Server ' || NEW.id
     END
   WHERE id = NEW.id;
END;

-- Update seed display_name untuk provider yang sudah ada
UPDATE providers SET display_name = 'Nokos.ID Server' WHERE provider_code = 'ruangotp';
UPDATE providers SET display_name = 'Server 2'        WHERE provider_code = 'kirimkode';

-- Catatan:
--   - display_name BISA diubah admin via panel (mis. "Server Jakarta", "Server Premium").
--   - provider_code TIDAK diubah — tetap sebagai key internal adapter registry.
--   - API publik (/api/otp/*) HANYA return display_name, TIDAK provider_code/provider_name.
--   - API admin (/api/admin/providers/*) return keduanya (RBAC protected).
