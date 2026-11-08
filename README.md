# Nokos.ID V2 — Angga Official

Platform nomor virtual & OTP dengan **Wallet Ledger**, **Deposit QRIS Manual**, **Panel Admin Multi-Admin 2FA**, dan integrasi **RuangOTP**. Dibangun di Cloudflare Pages + Functions + D1 + R2.

> **Catatan keamanan:** Proyek ini mengimplementasikan ledger finansial immutable, idempotency key anti double-spend, RBAC 4-role, 2FA wajib admin, dan audit log penuh. Sumber kebenaran saldo adalah tabel `wallet_transactions` (append-only), bukan kolom `wallets.balance` (yang di-update via trigger).

---

## Daftar Isi

1. [Fitur](#fitur)
2. [Teknologi](#teknologi)
3. [Struktur Folder](#struktur-folder)
4. [Persyaratan](#persyaratan)
5. [Instalasi](#instalasi)
6. [Konfigurasi Cloudflare](#konfigurasi-cloudflare)
   - [Database D1](#database-d1)
   - [KV Namespace](#kv-namespace)
   - [R2 Bucket](#r2-bucket)
   - [Secrets](#secrets)
7. [Konfigurasi RuangOTP](#konfigurasi-ruangotp)
8. [Konfigurasi QRIS Angga Official](#konfigurasi-qris-angga-official)
9. [Database Migration](#database-migration)
10. [Menjalankan Development Server](#menjalankan-development-server)
11. [Membuat Admin](#membuat-admin)
12. [Aktivasi 2FA Admin](#aktivasi-2fa-admin)
13. [Verifikasi Deposit](#verifikasi-deposit)
14. [Multi-Provider OTP Management](#multi-provider-otp-management)
15. [Hidden Provider System](#hidden-provider-system)
16. [Build & Deployment](#build--deployment)
17. [Testing](#testing)
18. [Troubleshooting](#troubleshooting)
19. [Backup & Pemulihan](#backup--pemulihan-data)
20. [Aturan Etika](#aturan-etika)

---

## Fitur

### Sistem Wallet Ledger
- Saldo integer Rupiah (cents), tidak pernah minus (CHECK + trigger).
- Setiap perubahan saldo = satu baris di `wallet_transactions` (append-only).
- `balance_before`, `balance_after`, `transaction_type`, `idempotency_key`, `status` dicatat.
- `idempotency_key` UNIQUE → anti double-credit & double-refund.
- Atomic D1 `batch()`: ledger INSERT + wallet UPDATE dalam satu transaksi.
- Reconcile otomatis: `SUM(delta_cents)` == `wallets.balance`.

### Deposit QRIS Manual
- QRIS statis merchant **Angga Official** (lihat `public/assets/qris-angga-official.png`).
- Alur: pilih nominal → tampilkan QR → scan via e-wallet → upload bukti → admin verifikasi.
- Bukti disimpan di **R2 privat** dengan nama acak (`crypto.randomUUID`), akses signed URL 1 jam.
- Retensi bukti 90 hari sesuai UU PDP.
- Approve = insert ledger (+amount) atomic; saldo bertambah **satu kali**.
- Reject = saldo tidak berubah; alasan wajib, notifikasi ke user.
- Status: `pending`, `approved`, `rejected`, `cancelled`.

### Panel Admin Multi-Admin
- 4 role: `super_admin`, `admin_deposit`, `admin_support`, `admin_ops`.
- RBAC di-backend (bukan hanya sembunyi tombol frontend).
- **2FA TOTP wajib** untuk semua admin sebelum bisa verifikasi deposit.
- Recovery codes (10 buah, satu kali pakai).
- Audit log penuh: login, approve, reject, refund, provider_call.
- Security events: login gagal, 2FA gagal, privilege denied.

### Integrasi RuangOTP
- Pembelian nomor via API provider (server-side only, `RUANGOTP_API_KEY` di Cloudflare Secrets).
- Fitur: negara, layanan, harga, stok, get-number, get-status, set-status, order history.
- Atomic: cek saldo → potong via ledger → panggil provider → bila gagal refund via ledger.
- Anti double-spend: `idempotency_key` per order.
- Provider timeout → **tidak** retry otomatis, admin cek status manual.
- Webhook SMS masuk (bila provider dukung) dengan HMAC signature verification.

### Keamanan
- Password: PBKDF2-SHA256, 210.000 iterasi, salt 16 byte acak.
- Session: cookie `HttpOnly; Secure; SameSite=Lax`, server-side revocable.
- CSRF double-submit token (header `X-CSRF-Token` == cookie `nokos_csrf`).
- Rate-limit via KV: auth 5/menit/IP, deposit 5/menit/user, otp 10/menit/user, admin 30/menit.
- CSP ketat, HSTS, Permissions-Policy, X-Frame-Options DENY.
- Upload validasi: MIME allow-list (JPG/PNG/WebP) + magic bytes + max 5MB.
- IDOR guard: deposit/order hanya bisa diakses pemilik atau admin.
- Tidak ada secret/API key di frontend atau di log.

---

## Teknologi

| Lapisan | Teknologi |
|---|---|
| Frontend | HTML5 + CSS3 + vanilla JS ES6+ (PWA: manifest + service worker) |
| Backend | Cloudflare Pages Functions (`functions/api/**`) |
| Database | Cloudflare D1 (SQLite) |
| Cache/Rate-limit | Cloudflare KV |
| Penyimpanan bukti | Cloudflare R2 (bucket PRIVATE) |
| Provider OTP | RuangOTP API |
| Secrets | Cloudflare Secrets (`wrangler pages secret put`) |

---

## Struktur Folder

```
nokos-id-v2/
├── public/                         # Frontend (static)
│   ├── index.html                  # Landing
│   ├── login.html / daftar.html / lupa-sandi.html
│   ├── dashboard.html              # Saldo, pesanan, deposit terakhir
│   ├── deposit.html               # QRIS Manual: pilih nominal + QR + upload bukti
│   ├── wallet.html                 # Riwayat transaksi ledger
│   ├── katalog.html               # Beli nomor (negara, layanan, harga)
│   ├── order.html                  # Detail order + polling OTP
│   ├── riwayat.html               # Riwayat deposit
│   ├── kontak.html
│   ├── kebijakan-privasi.html / syarat-layanan.html / kebijakan-refund.html
│   ├── admin/
│   │   ├── index.html              # Statistik admin
│   │   ├── verifikasi.html         # Antrian bukti QRIS (approve/reject)
│   │   ├── audit.html              # Audit log
│   │   └── 2fa-setup.html          # Setup TOTP + recovery codes
│   ├── assets/
│   │   ├── qris-angga-official.png # QRIS statis merchant Angga Official
│   │   ├── nokos-logo.png
│   │   └── logo.svg
│   ├── styles.css  app.js  sw.js  manifest.webmanifest  _headers  _redirects
├── functions/api/
│   ├── _health.js
│   ├── notifications.js
│   ├── auth/    register.js login.js logout.js me.js 2fa/setup.js 2fa/verify.js
│   ├── wallet/  index.js transactions.js
│   ├── deposits/ index.js [id]/index.js [id]/proof.js [id]/cancel.js
│   ├── admin/   deposits/index.js [id]/approve.js [id]/reject.js [id]/proof.js
│   │             stats.js audit-log.js
│   ├── otp/     countries.js services.js prices.js orders/index.js
│   │            orders/[id]/index.js orders/[id]/cancel.js orders/[id]/status.js
│   └── webhooks/ sms-provider.js
├── src/
│   ├── db.js            # D1 helper (run/first/all/batch)
│   ├── utils.js         # ULID, formatIDR, json response, escapeHTML
│   ├── security.js       # PBKDF2 hash, AES-GCM encrypt, HMAC
│   ├── totp.js           # RFC 6238 TOTP + recovery codes
│   ├── session.js        # Session cookie + CSRF double-submit
│   ├── rate-limit.js     # KV sliding window
│   ├── validation.js     # Whitelist input validation
│   ├── wallet-ledger.js  # INTI: postTransaction atomic, reconcile
│   ├── deposit.js        # createDeposit, approveDeposit, rejectDeposit
│   ├── otp.js            # createOrder, confirmOrder, refundOrder, pollStatus
│   ├── settings.js       # system_settings key-value
│   ├── r2.js             # upload/stream proof di R2
│   ├── middleware.js     # withHandler wrapper (auth/csrf/rate/rbac/audit)
│   └── providers/ruangotp.js  # Adapter API RuangOTP
├── migrations/
│   ├── 0001_init.sql           # Semua tabel + trigger ledger
│   ├── 0002_indexes.sql       # Index + seed admin pertama
│   ├── 0003_multi_provider.sql # Tabel providers, provider_services, provider_logs + kolom provider_id
│   └── 0004_hidden_provider.sql # Kolom display_name (Nokos.ID Server / Server N) + trigger
├── tests/                 # Vitest (mock D1 via better-sqlite3)
│   ├── helpers/mock-db.js
│   ├── wallet-ledger.test.js
│   ├── deposit.test.js
│   └── security.test.js
├── wrangler.toml  package.json  vitest.config.js  .gitignore  README.md
```

---

## Persyaratan

- Node.js 18+
- Akun Cloudflare (Free tier cukup untuk development)
- `wrangler` CLI: `npm install -g wrangler` atau pakai `npx`
- Akun RuangOTP dengan API Key (untuk pembelian nomor)

---

## Instalasi

```bash
# 1. Ekstrak ZIP proyek
unzip NokosID-AnggaOfficial-V2.zip
cd nokos-id-v2

# 2. Install dependency
npm install

# 3. Login Cloudflare
npx wrangler login

# 4. Lanjut ke konfigurasi (lihat bagian berikutnya)
```

---

## Konfigurasi Cloudflare

### Database D1

```bash
# Buat database D1
npx wrangler d1 create nokos-db
```

Output akan menampilkan `database_id`. Salin ID tersebut ke `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "nokos-db"
database_id = "PASTE_ID_ANDA_DI_SINI"
```

### KV Namespace

```bash
# Buat 2 KV namespace
npx wrangler kv namespace create RATE_LIMIT
npx wrangler kv namespace create SESSIONS
```

Salin `id` dari output ke `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "PASTE_ID_RATE_LIMIT"

[[kv_namespaces]]
binding = "SESSIONS"
id = "PASTE_ID_SESSIONS"
```

### R2 Bucket

Buat bucket R2 **PRIVATE** (jangan enable public-read):

```bash
npx wrangler r2 bucket create nokos-bukti
```

`wrangler.toml`:

```toml
[[r2_buckets]]
binding = "BUKTI"
bucket_name = "nokos-bukti"
```

### Secrets

Jalankan perintah berikut, paste nilai saat diminta:

```bash
# Secret penandatanganan cookie session (>=32 byte acak)
# Generate: openssl rand -hex 32
npx wrangler pages secret put JWT_SECRET

# Kunci enkripsi TOTP secret admin (32 byte)
npx wrangler pages secret put ENCRYPTION_KEY

# API Key dari dashboard RuangOTP
npx wrangler pages secret put RUANGOTP_API_KEY

# Base URL RuangOTP (lihat bagian RuangOTP)
npx wrangler pages secret put RUANGOTP_BASE_URL

# (Opsional) Shared secret untuk webhook SMS
npx wrangler pages secret put RUANGOTP_WEBHOOK_SECRET
```

Untuk development lokal, buat file `.dev.vars` (sudah di `.gitignore`):

```env
JWT_SECRET=dev-jwt-secret-32bytes-long-xxxxxx
ENCRYPTION_KEY=dev-encryption-key-32bytes-long-xx
RUANGOTP_API_KEY=your-test-key
RUANGOTP_BASE_URL=https://ruangotp.io/api
RUANGOTP_WEBHOOK_SECRET=dev-webhook-secret
QRIS_MERCHANT_NAME=Angga Official
```

---

## Konfigurasi RuangOTP

Dokumentasi resmi RuangOTP: `https://ruangotp.io/api/dev` (butuh login dashboard).

### Endpoint yang Terkonfirmasi Publik

Saat riset, hanya endpoint berikut yang terverifikasi via search engine index:

| Endpoint | Method | Deskripsi |
|---|---|---|
| `/country-v2/list` | GET | Daftar negara |

### Path Map (perlu verifikasi dashboard)

Endpoint lain (services, prices, get-number, get-status, set-status, order-history) **belum diverifikasi** dari sumber publik. Adapter di `src/providers/ruangotp.js` memakai **path map yang dapat dikonfigurasi via env** tanpa mengarang default yang berbeda dari pola umum terlihat:

| Env Var | Default | Keterangan |
|---|---|---|
| `RUANGOTP_BASE_URL` | `https://ruangotp.io/api` | Base URL API |
| `RUANGOTP_PATH_COUNTRIES` | `/country-v2/list` | Daftar negara |
| `RUANGOTP_PATH_SERVICES` | `/service-v2/list` | Daftar layanan |
| `RUANGOTP_PATH_PRICES` | `/price-v2/list` | Cek harga |
| `RUANGOTP_PATH_GET_NUMBER` | `/order-v2/get-number` | Beli nomor |
| `RUANGOTP_PATH_GET_STATUS` | `/order-v2/get-status` | Cek status OTP |
| `RUANGOTP_PATH_SET_STATUS` | `/order-v2/set-status` | Cancel/aksi |
| `RUANGOTP_PATH_ORDER_HISTORY` | `/order-v2/history` | Riwayat |
| `RUANGOTP_AUTH_IN_QUERY` | `0` | `1` = kirim api_key via query, default `0` = header `Authorization: Bearer` |

### Langkah Verifikasi (WAJIB sebelum go-live)

1. Login ke dashboard RuangOTP, buka halaman dokumentasi API.
2. Catat **endpoint path** persis untuk setiap action di atas.
3. Override via Cloudflare Secret:

   ```bash
   npx wrangler pages secret put RUANGOTP_BASE_URL
   npx wrangler pages secret put RUANGOTP_PATH_GET_NUMBER
   # ... dst untuk setiap path yang berbeda dari default
   ```

4. Atau bila autentikasi via query (`?api_key=`), set `RUANGOTP_AUTH_IN_QUERY=1`.

5. **Uji panggilan pertama** ke `/api/otp/countries` setelah deploy. Bila response tidak valid, sesuaikan path map.

> **Penting:** Adapter tidak mengarang response — parser toleran menerima JSON modern `{id, number, status}` maupun string gaya sms-activate `ACCESS_NUMBER:id:number` / `STATUS_OK:sms`. Log mentah provider disimpan di tabel `provider_responses` untuk debug.

---

## Konfigurasi QRIS Angga Official

QRIS statis merchant Angga Official sudah disertakan di `public/assets/qris-angga-official.png`. Untuk mengganti QRIS:

1. Ganti file `public/assets/qris-angga-official.png` dengan QRIS baru.
2. Update nama merchant via panel admin (atau langsung DB):

   ```sql
   UPDATE system_settings SET value = 'Angga Official', updated_at = strftime('%s','now')
   WHERE key = 'qris_merchant_name';
   ```

3. Atur batas nominal (default min Rp10.000, max Rp5.000.000):

   ```sql
   UPDATE system_settings SET value = '10000' WHERE key = 'qris_min_amount_cents';
   UPDATE system_settings SET value = '50000000' WHERE key = 'qris_max_amount_cents';
   ```

4. Preset nominal default: `10000,25000,50000,100000,200000,500000` (edit via `qris_preset_amounts`).

> QRIS dipakai untuk pembayaran top-up ke merchant Angga Official. **Jangan** ganti ke merchant lain tanpa persetujuan. Bukti transaksi yang diupload diperlakukan sebagai data pribadi (retensi 90 hari).

---

## Database Migration

```bash
# Production (remote D1)
npx wrangler d1 execute nokos-db --file=migrations/0001_init.sql
npx wrangler d1 execute nokos-db --file=migrations/0002_indexes.sql
npx wrangler d1 execute nokos-db --file=migrations/0003_multi_provider.sql
npx wrangler d1 execute nokos-db --file=migrations/0004_hidden_provider.sql

# Development lokal (D1 local)
npx wrangler d1 execute nokos-db --local --file=migrations/0001_init.sql
npx wrangler d1 execute nokos-db --local --file=migrations/0002_indexes.sql
npx wrangler d1 execute nokos-db --local --file=migrations/0003_multi_provider.sql
npx wrangler d1 execute nokos-db --local --file=migrations/0004_hidden_provider.sql
```

Atau jalankan sekali:

```bash
npm run db:migrate          # remote
npm run db:migrate:local    # local
```

---

## Menjalankan Development Server

```bash
npm run dev
```

Buka `http://localhost:8788`. Pastikan `.dev.vars` sudah diisi (lihat Secrets).

Untuk D1 local, jalankan migration local dulu:

```bash
npm run db:migrate:local
```

---

## Membuat Admin

Setelah migration, ada 1 admin default (`superadmin` / `admin@nokos.id`) tetapi password-nya placeholder. **Ganti sebelum deploy!**

### Cara 1: Script create-admin

```bash
node scripts/create-admin.js
```

Script akan meminta username, email, password baru, dan role. Password di-hash dengan PBKDF2 lalu update ke DB.

### Cara 2: Manual via wrangler

```bash
# Generate hash password (jalankan di Node)
node -e "
const crypto = require('crypto');
const password = 'PasswordBaruAnda!2026';
const salt = crypto.randomBytes(16);
crypto.pbkdf2(password, salt, 210000, 32, 'sha256', (err, hash) => {
  console.log('\$pbkdf2-sha256\$210000\$' + salt.toString('base64') + '\$' + hash.toString('base64'));
});
"

# Lalu update DB
npx wrangler d1 execute nokos-db --command \
  "UPDATE users SET password_hash='\$pbkdf2-sha256\$...' WHERE email='admin@nokos.id';"
```

### Cara 3: Promote user biasa ke admin

Setelah user register via web, jalankan:

```bash
npx wrangler d1 execute nokos-db --command \
  "UPDATE users SET role='admin_deposit' WHERE email='user@email.com';"

npx wrangler d1 execute nokos-db --command \
  "INSERT INTO admin_users (user_id, role, created_at)
   SELECT id, role, strftime('%s','now') FROM users WHERE email='user@email.com';"
```

---

## Aktivasi 2FA Admin

**Wajib** sebelum admin bisa verifikasi deposit.

1. Login sebagai admin → otomatis diarahkan ke setup 2FA (atau buka `/admin/2fa-setup.html`).
2. Klik "Mulai Setup 2FA".
3. Scan QR dengan Google Authenticator / Authy / 1Password.
4. **Simpan recovery codes** di tempat aman (hanya ditampilkan sekali).
5. Masukkan kode 6-digit → klik "Aktifkan 2FA".

Bila 2FA belum aktif, semua endpoint admin yang sensitif menolak dengan `2FA_REQUIRED`.

---

## Verifikasi Deposit

1. User membuat deposit di `/deposit.html` (pilih nominal → scan QRIS → upload bukti).
2. Admin buka `/admin/verifikasi.html`.
3. Filter status "pending".
4. Klik "Lihat" pada kolom bukti → modal menampilkan gambar bukti.
5. Periksa: nominal cocok, bukti valid, merchant Angga Official.
6. Klik **Approve** (saldo user +amount via ledger, satu kali) atau **Reject** (wajib isi alasan, saldo tidak berubah).
7. User mendapat notifikasi otomatis.

---

## Multi-Provider OTP Management

Nokos.ID V2 mendukung **beberapa provider OTP secara bersamaan** (RuangOTP, KirimKode, dan provider tambahan) dengan arsitektur modular. Penambahan provider baru tidak memerlukan pembangunan ulang sistem — cukup buat adapter class baru dan daftarkan di `src/providers/registry.js`.

### Arsitektur

| Komponen | File | Fungsi |
|---|---|---|
| BaseAdapter | `src/providers/base.js` | Kontrak interface 10 metode: getCountries, getServices, getOperators, getPrices, getAvailability, purchaseNumber, getOrderStatus, getOtp, cancelOrder, getBalance |
| RuangOTPAdapter | `src/providers/ruangotp.js` | Implementasi untuk RuangOTP |
| KirimKodeAdapter | `src/providers/kirimkode.js` | Implementasi config-driven untuk KirimKode |
| Registry | `src/providers/registry.js` | Map `provider_code → AdapterClass`, load konfigurasi dari DB |
| Provider Manager | `src/provider-manager.js` | CRUD provider, test koneksi, ambil saldo, statistik |
| Routing | `src/routing.js` | Smart routing: manual / cheapest / priority / availability |

### Database (Migration 0003)

Tambahan tabel:
- `providers` — konfigurasi provider (base_url, auth_method, markup, priority, status). **API key TIDAK disimpan di sini** — hanya `api_key_secret_name` (nama Cloudflare Secret).
- `provider_services` — cache layanan per provider.
- `provider_logs` — audit setiap panggilan API provider (tanpa rahasia).
- `otp_orders.provider_id` — kolom baru (FK ke providers) untuk multi-provider.

Seed default:
- `ruangotp` (inactive, priority 1, default) — path map terkonfirmasi `/country-v2/list`.
- `kirimkode` (inactive, priority 2) — path map berisi placeholder `PASTE_PATH`, **wajib diverifikasi dari dashboard KirimKode** sebelum aktivasi.

### Menambahkan Provider Baru

1. Buat file `src/providers/namaprovider.js` meng-extend `BaseAdapter`:
   ```js
   import { BaseAdapter } from "./base.js";
   export class NamaProviderAdapter extends BaseAdapter {
     async getCountries() { /* ... */ }
     async purchaseNumber({country, service, operator}, otpOrderId) { /* ... */ }
     // implementasi method lain yang didukung
   }
   ```
2. Daftarkan di `src/providers/registry.js`:
   ```js
   const ADAPTERS = { ruangotp: RuangOTPAdapter, kirimkode: KirimKodeAdapter, namaprovider: NamaProviderAdapter };
   ```
3. Buat provider via panel admin `/admin/providers.html` → "Tambah Provider".
4. Set Cloudflare Secret: `wrangler pages secret put NAMAPROVIDER_API_KEY`.
5. Test koneksi → bila OK, aktivasi.

### Smart Routing

Di halaman `/katalog.html`, user pilih mode:

| Mode | Perilaku |
|---|---|
| `priority` (default) | Provider aktif dengan priority terendah (is_default dulu) |
| `cheapest` | Bandingkan harga jual semua provider, ambil termurah |
| `availability` | Provider yang punya nomor tersedia |
| `manual` | User pilih provider sendiri |

Aturan (master prompt 17.F):
- Provider harus `status='active'` dan lolos test koneksi.
- Setelah nomor berhasil diterbitkan, **TIDAK** otomatis pindah ke provider lain.
- Bila provider timeout dengan status belum diketahui → cek status provider pertama dulu sebelum mencoba provider lain (anti double purchase).

### Unified Wallet

Semua pembelian dari semua provider memakai **satu saldo internal Nokos.ID**. Contoh:
- Saldo user: Rp100.000
- Beli via RuangOTP: Rp10.000 → saldo Rp90.000
- Beli via KirimKode: Rp15.000 → saldo Rp75.000

Setiap `otp_orders` mencatat `provider_id` + `provider_order_id` (unik per provider). Wallet Ledger tetap sumber kebenaran finansial; saldo provider dikelola masing-masing provider (bukan dicampur dengan saldo user).

### API Endpoint Multi-Provider

**User-facing:**
- `GET /api/otp/providers` — daftar provider aktif
- `GET /api/otp/countries?provider=ruangotp` — negara dari provider tertentu
- `GET /api/otp/services?country=ID&provider=ruangotp` — layanan dari provider
- `GET /api/otp/prices?country=ID&service=wa&provider=ruangotp` — harga + markup
- `GET /api/otp/route?country=ID&service=wa&mode=cheapest` — smart routing → provider terpilih + harga jual
- `POST /api/otp/orders` (body: `{provider_id, country_id, service_id, routing_mode}`)

**Admin (super_admin):**
- `GET /api/admin/providers` — daftar semua provider
- `POST /api/admin/providers` — buat provider baru
- `GET /api/admin/providers/:id` — detail
- `PATCH /api/admin/providers/:id` — update (status, priority, markup, dll)
- `DELETE /api/admin/providers/:id` — hapus (wajib disabled + tidak ada order terkait)
- `POST /api/admin/providers/:id/test` — test koneksi (wajib lulus sebelum aktivasi)
- `POST /api/admin/providers/:id/balance` — ambil saldo provider
- `GET /api/admin/providers/stats` — statistik per-provider (order, success rate, response time)

### Aktivasi Provider (langkah wajib)

1. Login dashboard provider → catat base_url + path map (lihat `PROVIDER_VERIFY.md`).
2. Set Cloudflare Secret: `wrangler pages secret put RUANGOTP_API_KEY` (atau `KIRIMKODE_API_KEY`).
3. Buka `/admin/providers.html` → Edit provider → isi base_url, api_key_secret_name, path map (JSON).
4. Klik **Test** → bila OK, klik **Aktifkan**.
5. Provider siap dipakai di `/katalog.html`.

### Keamanan Multi-Provider

- API key di Cloudflare Secrets, **tidak pernah** disimpan di DB atau dikirim ke frontend.
- `provider_logs` mencatat `redacted_meta` + `redacted_response` (api_key di-redact).
- Timeout + retry per-provider (configurable via `timeout_ms`, `max_retries`).
- Idempotency: `idempotency_key` per order mencegah double-purchase lintas provider.
- Hapus provider: wajib `status=disabled` dulu + tidak ada order terkait (anti data loss).

---

## Hidden Provider System

Identitas provider asli (RuangOTP, KirimKode, dll) **sepenuhnya disembunyikan** dari user biasa. User hanya melihat nama generik ("Nokos.ID Server", "Server 1", "Server 2"). Hanya admin dengan izin yang melihat identitas asli via Admin Panel.

### Prinsip

| Aspek | User-facing | Admin-facing |
|---|---|---|
| Nama provider | `display_name` (Nokos.ID Server / Server N) | `provider_code` + `provider_name` asli |
| API key | TIDAK pernah dikirim | Cloudflare Secrets (referensi nama di DB) |
| base_url, endpoint | TIDAK terekspos | Terlihat di panel admin |
| `provider_order_id` | TIDAK di-return ke user | Tercatat di `otp_orders` (internal) |
| Markup / harga provider | TIDAK tampil; hanya `selling_price_cents` final | Terlihat di panel admin |
| `failure_reason` | Generic ("Pembelian gagal") | Detail asli di `wallet_audit_logs` |

### Implementasi (Migration 0004)

- Kolom `display_name` di tabel `providers` (diisi admin, default otomatis via trigger: `is_default=1` → "Nokos.ID Server", else "Server N").
- `provider_code` tetap sebagai key internal adapter registry (tidak diekspos ke publik).
- `otp_orders.provider_id` tetap dicatat untuk tracking admin, **TIDAK** di-return di API user.

### Lapisan Masking (`src/public-view.js`)

| Fungsi | Fungsi |
|---|---|
| `maskProvider(p)` | Return hanya `{ id, display_name }` |
| `maskProviderList(list)` | Array of masked |
| `getDisplayName(db, id)` | Ambil display_name dari DB |
| `sanitizeForUser(text)` | Strip referensi provider asli (ruangotp, kirimkode, sms-activate, api_key, base_url, BAD_KEY, NO_NUMBERS, dll) → "Nokos.ID Server" |
| `containsProviderLeak(text)` | Deteksi kebocoran (untuk test) |

### API Publik (masking aktif)

| Endpoint | Yang di-return | Yang TIDAK di-return |
|---|---|---|
| `GET /api/otp/providers` | `[{ id, display_name }]` | provider_code, provider_name, base_url, api_key |
| `GET /api/otp/countries?provider=<ID>` | `{ countries, server_name }` | provider_code, base_url |
| `GET /api/otp/services?country=&provider=<ID>` | `{ services, server_name }` | provider_code |
| `GET /api/otp/prices?...&provider=<ID>` | `{ prices: [{..., selling_price_cents}], server_name }` | provider_code, provider_cost_cents, markup_percent |
| `GET /api/otp/route?...&mode=` | `{ ok, provider_id, server_name, selling_price_cents, mode }` | provider_code, provider_config, provider_cost_cents, markup_percent |
| `GET /api/otp/orders/:id` | `{ order: { id, ..., server_name } }` | provider_code, provider_order_id, failure_reason |
| `GET /api/otp/orders` | `[{ id, ..., server_name }]` | provider_code, provider_name |
| `POST /api/otp/orders/:id` (confirm) | `{ status, phone_number, cost_cents, failure_reason? }` | provider_code, provider_order_id |
| Notifikasi user | Title/body generic | Tanpa nama provider |

**Catatan penting:** parameter `?provider=` di endpoint publik sekarang menerima **ID internal (angka)**, BUKAN `provider_code`. User tidak pernah tahu `provider_code` asli.

### API Admin (RBAC protected — tidak masking)

`/api/admin/providers/*` return field lengkap (`provider_code`, `provider_name`, `base_url`, `api_key_secret_name`, `configuration`). Endpoint ini hanya bisa diakses admin yang login + 2FA + role sesuai (`super_admin` untuk CRUD, admin lain untuk view).

### Admin Panel — `display_name` editor

Di `/admin/providers.html`, admin bisa:
- Lihat kolom "Nama Asli" + "Tampil ke User" berdampingan.
- Edit `display_name` (field "Display Name (User-facing)") saat tambah/edit provider.
- Aturan: **jangan isi nama provider asli** di display_name. Default auto ("Nokos.ID Server" / "Server N").

### Keamanan tambahan

- **Sanitasi error**: semua pesan error yang dikirim ke user dilewati `sanitizeForUser()` sebelum dikirim. Detail asli (dengan nama provider) tetap di `wallet_audit_logs` + `provider_logs` (internal).
- **Tidak ada bypass frontend**: masking dilakukan di backend (response API), bukan CSS hide. User tidak bisa inspect Network tab untuk lihat nama provider.
- **No source map leak**: file `src/providers/*.js` (yang berisi nama provider) tidak di-bundle ke frontend — hanya jalan di Cloudflare Pages Functions (server-side).
- **Idempotency tetap utuh**: `idempotency_key` per order mencegah double-purchase lintas provider.
- **Tracking internal tetap ada**: `otp_orders.provider_id` + `wallet_audit_logs.details.provider_code` untuk admin melacak provider mana yang memproses order.

### Pengujian (16 test di `tests/hidden-provider.test.js`)

| Test | Status |
|---|---|
| maskProvider hanya return { id, display_name } | ✅ |
| maskProvider default display_name (Nokos.ID Server / Server N) | ✅ |
| maskProviderList strip semua field sensitif | ✅ |
| getDisplayName ambil dari DB | ✅ |
| sanitizeForUser strip nama provider asli | ✅ |
| sanitizeForUser strip api_key / secret / base_url / endpoint | ✅ |
| sanitizeForUser strip kode error provider (BAD_KEY, NO_NUMBERS) | ✅ |
| containsProviderLeak deteksi kebocoran | ✅ |
| listUserOrders return server_name, BUKAN provider_code/name | ✅ |
| listUserOrders fallback "Nokos.ID Server" bila provider_id NULL | ✅ |
| confirmOrder response tidak mengandung provider_code/provider_order_id | ✅ |
| notification body tidak mengandung nama provider asli | ✅ |
| otp_orders.provider_id tercatat untuk tracking admin | ✅ |
| wallet_audit_logs mencatat detail internal (admin-only) | ✅ |

---

## Build & Deployment

```bash
# Deploy ke production
npm run deploy

# Atau manual
npx wrangler pages deploy public --project-name=nokos-id
```

### Setup domain kustom

1. Dashboard Cloudflare → Pages → proyek `nokos-id` → Custom domains.
2. Tambah domain (mis. `nokos.id`), ikuti instruksi DNS.
3. SSL: pakai **Full (strict)**.

### Setup webhook RuangOTP

Di dashboard RuangOTP, set webhook URL ke:

```
https://nokos.id/api/webhooks/sms-provider
```

(Bila provider dukung webhook SMS masuk. Bila tidak, polling otomatis via `/api/otp/orders/:id/status`.)

### Setup WAF & Turnstile (opsional)

- Cloudflare dashboard → Security → WAF: tambah rule rate-limit untuk `/api/auth/*`.
- Turnstile: daftar site key, tambahkan ke halaman login/register.

---

## Testing

```bash
# Jalankan semua test
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

### Skenario yang Diuji

| Test | File | Yang Diverifikasi |
|---|---|---|
| Wallet ledger atomic | `wallet-ledger.test.js` | kredit/debit update balance + ledger konsisten |
| Idempotency anti double-credit | `wallet-ledger.test.js` | idempotency_key sama → saldo tidak ganda |
| Reconcile | `wallet-ledger.test.js` | SUM(ledger) == wallet.balance |
| Saldo minus dicegah | `wallet-ledger.test.js` | postTransaction dengan amount > balance → throw |
| Deposit approve 1x | `deposit.test.js` | approve kedua → already_approved, saldo tidak ganda |
| Deposit reject | `deposit.test.js` | saldo tidak berubah, alasan tersimpan |
| Deposit cancel | `deposit.test.js` | status cancelled |
| IDOR guard | `deposit.test.js` | user B tidak bisa upload proof ke deposit user A |
| RBAC approve | `deposit.test.js` | admin_support tidak bisa approve |
| 2FA wajib | `deposit.test.js` | admin tanpa 2FA → reject |
| Password hash | `security.test.js` | PBKDF2 verify, salt acak |
| AES-GCM | `security.test.js` | encrypt/decrypt TOTP secret |
| TOTP RFC 6238 | `security.test.js` | generate/verify kode 6 digit |
| Recovery codes | `security.test.js` | format unik |
| HMAC webhook | `security.test.js` | signature deterministik |
| Registry & adapter selection | `multi-provider.test.js` | getAdapter inactive/force, code tidak terdaftar |
| Smart routing | `multi-provider.test.js` | computeSellPrice, priority/cheapest/manual, no-active-provider |
| Provider CRUD | `multi-provider.test.js` | create (inactive), update (test_ok required), delete (disabled + no orders) |
| Provider stats | `multi-provider.test.js` | totals + per-provider |
| Order with provider_id | `multi-provider.test.js` | createOrder simpan provider_id, markup per-provider |
| Legacy order backfill | `multi-provider.test.js` | confirmOrder fallback ke default provider bila NULL |
| Double purchase prevention | `multi-provider.test.js` | confirmOrder kedua → already_processed |
| Refund idempotent | `multi-provider.test.js` | refundOrder kedua → already_refunded, saldo tidak ganda |
| Base adapter contract | `multi-provider.test.js` | UnsupportedError untuk method tidak diimplementasi |
| Parser sms-activate | `multi-provider.test.js` | ACCESS_NUMBER, STATUS_OK, NO_NUMBERS |
| Masking layer (maskProvider) | `hidden-provider.test.js` | return hanya { id, display_name }, strip code/name/url/secret |
| Sanitization (sanitizeForUser) | `hidden-provider.test.js` | strip ruangotp, kirimkode, sms-activate, api_key, base_url, BAD_KEY |
| User tidak lihat provider_code | `hidden-provider.test.js` | listUserOrders return server_name only |
| Notification tidak bocor | `hidden-provider.test.js` | body notifikasi tanpa nama provider asli |
| Internal tracking tetap ada | `hidden-provider.test.js` | otp_orders.provider_id + wallet_audit_logs |

### Test manual yang perlu dilakukan setelah deploy

1. Register user baru → auto-login.
2. Login admin (tanpa 2FA → ditolak, setup 2FA, login ulang).
3. User deposit Rp50.000 → upload bukti → admin approve → saldo +50.000.
4. User deposit → admin reject → saldo 0.
5. User beli nomor (perlu saldo cukup + provider aktif).
6. Cek OTP polling → SMS masuk → status completed.
7. Cancel order → refund (bila provider mengizinkan).
8. Verifikasi tidak ada double-spend: jalankan 2 request bersamaan.

---

## Troubleshooting

### "D1 binding 'DB' tidak tersedia"
- Pastikan `wrangler.toml` punya `[[d1_databases]]` dengan binding `DB`.
- Saat dev lokal, jalankan dengan `--local` dan pastikan `.wrangler/` ada.

### "R2 binding 'BUKTI' tidak tersedia"
- Pastikan `[[r2_buckets]]` di `wrangler.toml` dengan binding `BUKTI`.

### "RUANGOTP_API_KEY belum dikonfigurasi"
- Jalankan `npx wrangler pages secret put RUANGOTP_API_KEY`.
- Untuk dev: isi di `.dev.vars`.

### Provider timeout / nomor tidak diterima
- Cek log `provider_responses` di D1: `SELECT * FROM provider_responses ORDER BY created_at DESC LIMIT 10;`
- Verifikasi `RUANGOTP_BASE_URL` dan path map benar (lihat [Konfigurasi RuangOTP](#konfigurasi-ruangotp)).
- Bila saldo provider habis (`NO_BALANCE`), isi ulang saldo provider.
- Bila `NO_NUMBERS`, coba layanan/negara lain.

### Saldo tidak bertambah setelah approve
- Cek `wallet_audit_logs` apakah `deposit_approve` tercatat.
- Cek `wallet_transactions` apakah ada entry `transaction_type='deposit'` dengan `reference_id` = deposit.id.
- Cek `deposits.ledger_id` — bila NULL, approve gagal di tahap ledger.
- Jalankan `reconcileWallet(userId)` untuk cek konsistensi.

### 2FA admin tidak bisa diaktifkan
- Pastikan `ENCRYPTION_KEY` sudah di-set (32 byte).
- Cek `admin_users.two_factor_secret_enc` tidak NULL.
- Bila lupa recovery codes, super_admin bisa regenerate via `/admin/2fa-setup.html`.

### Bukti pembayaran tidak bisa diupload
- Cek file: format JPG/PNG/WebP, maks 5MB.
- Cek R2 bucket `nokos-bukti` ada dan binding `BUKTI` benar.
- Cek `deposits.payment_proof_key` terisi setelah upload.

### Webhook SMS tidak diterima
- Pastikan URL publik: `https://nokos.id/api/webhooks/sms-provider`.
- Bila `RUANGOTP_WEBHOOK_SECRET` di-set, signature harus cocok.
- Cek method POST, Content-Type application/json.
- Bila provider tidak dukung webhook, pakai polling otomatis (default aktif).

---

## Backup & Pemulihan Data

### Backup D1

```bash
# Export ke file SQL
npx wrangler d1 execute nokos-db --command ".dump" --output backup-$(date +%Y%m%d).sql

# Atau export tabel tertentu
npx wrangler d1 execute nokos-db --command \
  "SELECT * FROM wallet_transactions;" --json --output wallet-ledger-backup.json
```

### Backup R2 (bukti pembayaran)

```bash
# List objects
npx wrangler r2 object list nokos-bukti/proofs/

# Download object
npx wrangler r2 object get nokos-bukti/proofs/<key> --file backup-proof.bin
```

### Pemulihan

```bash
# Restore D1 dari backup
npx wrangler d1 execute nokos-db --file=backup-20260101.sql

# Verifikasi konsistensi ledger
node scripts/reconcile-all.js
```

### Jadwal backup otomatis (opsional)

Pakai Cloudflare Cron Trigger atau GitHub Actions untuk backup harian D1 ke R2. Contoh minimal: jalankan `wrangler d1 execute ... --output` tiap malam via CI.

---

## Aturan Etika

Nokos.ID hanya untuk pengujian pada sistem milik sendiri atau yang diizinkan pemiliknya. **Dilarang keras:**

- Pengambilalihan akun pihak lain.
- Bypass 2FA tanpa izin pemilik akun.
- Akses akun bank, dompet digital, kartu kredit, atau layanan finansial lain.
- Penipuan, spam massal, pencurian identitas.

Patuhi UU ITE (UU No. 11/2008 jo. UU No. 19/2016), UU PDP (UU No. 27/2022), regulasi Kominfo, dan ToS setiap platform target. Pelanggaran menyebabkan suspensi permanen dan/atau pelaporan ke pihak berwenang.

---

## Lisensi

Proprietary — Angga Official. Hubungi `support@nokos.id` untuk lisensi komersial.
