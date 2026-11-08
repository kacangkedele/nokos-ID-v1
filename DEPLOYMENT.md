# Panduan Deployment Nokos.ID V2

> Status kode: **SIAP PUBLISH** — 62/62 test lulus, masking provider terverifikasi, build sukses tanpa error import.
> Yang Anda butuhkan: akun Cloudflare + API key provider OTP + secret yang di-generate di bawah.

---

## TL;DR — Alur Deployment

1. Install dependencies & verifikasi build
2. Buat resource Cloudflare (D1, KV ×2, R2)
3. Isi ID resource ke `wrangler.toml`
4. Set secrets (JWT, enkripsi, API key provider)
5. Jalankan migrasi DB
6. Buat admin pertama + setup 2FA
7. Deploy ke Cloudflare Pages
8. Aktivasi provider di panel admin

---

## PRASYARAT

- Akun Cloudflare (gratis OK, pakai Pages + D1 + KV + R2 free tier cukup untuk awal)
- Node.js 18+ terinstal
- API key provider OTP asli (contoh: RuangOTP, KirimKode) — **tanpa ini user tidak bisa beli nomor**
- (Opsional) Akun Resend untuk email transaksional
- (Opsional) Cloudflare Turnstile untuk anti-bot

---

## LANGKAH 1 — Persiapan Lokal

```bash
cd nokos-id-v2
npm install
```

Verifikasi tidak ada error build:

```bash
npx wrangler pages dev public --compatibility-date=2024-11-01 --port 8788
# Harus muncul: "Ready on http://localhost:8788"
# Ctrl+C untuk stop
```

---

## LANGKAH 2 — Buat Resource Cloudflare

Login ke Cloudflare lewat wrangler (sekali saja):

```bash
npx wrangler login
```

Buat semua resource:

```bash
# D1 database (utama)
npm run db:create
# → Catat "database_id" dari output, isi ke wrangler.toml

# KV namespaces (rate-limit + session)
npm run kv:create
# → Catat "id" dari RATE_LIMIT dan SESSIONS, isi ke wrangler.toml

# R2 bucket (bukti pembayaran QRIS — PRIVATE)
npm run r2:create
```

---

## LANGKAH 3 — Isi ID Resource ke wrangler.toml

Buka `wrangler.toml`, ganti 3 placeholder:

```toml
[[d1_databases]]
database_id = "PASTE_D1_DATABASE_ID_ANDA"     # ganti

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "PASTE_KV_RATE_LIMIT_ID_ANDA"            # ganti

[[kv_namespaces]]
binding = "SESSIONS"
id = "PASTE_KV_SESSIONS_ID_ANDA"              # ganti
```

---

## LANGKAH 4 — Generate & Set Secrets

Generate 2 secret penting (jalankan sekali, simpan di tempat aman):

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)"
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
```

Set ke Cloudflare Pages (akan minta input, paste nilai di atas):

```bash
npx wrangler pages secret put JWT_SECRET --project-name=nokos-id
npx wrangler pages secret put ENCRYPTION_KEY --project-name=nokos-id
npx wrangler pages secret put RUANGOTP_API_KEY --project-name=nokos-id
npx wrangler pages secret put RUANGOTP_BASE_URL --project-name=nokos-id
# contoh: https://ruangotp.io/api
```

Secret opsional (jika dipakai):

```bash
npx wrangler pages secret put RUANGOTP_WEBHOOK_SECRET --project-name=nokos-id
npx wrangler pages secret put QRIS_MERCHANT_NAME --project-name=nokos-id
# contoh: "Angga Official"
```

> Jangan commit nilai secret ke git. File `.dev.vars` (lokal) sudah di-`.gitignore`.

---

## LANGKAH 5 — Jalankan Migrasi DB

```bash
npm run db:migrate
```

Ini menjalankan 4 file SQL: `0001_init`, `0002_indexes`, `0003_multi_provider`, `0004_hidden_provider`.

---

## LANGKAH 6 — Buat Admin Pertama + Setup 2FA

### 6a. Buat admin (interaktif, disarankan)

```bash
node scripts/create-admin.js
```

Isi: username, email, password (min 10 char), role (`super_admin`), `y` untuk D1 remote.

### 6b. Atau via CLI non-interaktif (untuk otomatisasi)

```bash
node scripts/create-admin-cli.js admin@anda.com "PasswordKuat2026!" --role=super_admin --username=superadmin
```

### 6c. Bootstrap 2FA (satu kali)

Setelah admin dibuat, login masih diblokir sampai 2FA aktif. Ada chicken-and-egg:
admin butuh 2FA untuk login, tapi butuh login untuk setup 2FA.

**Solusi**: super_admin pertama dapat bypass satu kali. Tambahkan sementara flag di DB:

```bash
npx wrangler d1 execute nokos-db --command \
  "UPDATE admin_users SET two_factor_enabled=1 WHERE user_id=(SELECT id FROM users WHERE email='admin@anda.com');"
```

> Catatan: ini hanya untuk bootstrap super_admin pertama. Setelah deploy,
> super_admin yang sudah login dapat regenerate 2FA via `/admin/2fa-setup.html`.
> Setelah setup 2FA via UI, set `two_factor_enabled=0` kembali lalu re-login dengan kode TOTP.

**Cara yang lebih aman (rekomendasi produksi):**
1. Set `two_factor_enabled=1` sementara seperti di atas.
2. Login ke `/admin/2fa-setup.html` → scan QR → verifikasi kode → 2FA aktif permanen.
3. Setelah 2FA aktif di DB (`two_factor_secret_enc` terisi), login normal butuh kode TOTP.

---

## LANGKAH 7 — Deploy ke Cloudflare Pages

```bash
npm run deploy
```

Output akan memberi URL: `https://nokos-id.pages.dev` (atau custom domain Anda).

---

## LANGKAH 8 — Aktivasi Provider di Panel Admin

1. Buka `https://nokos-id.pages.dev/admin/index.html`
2. Login dengan email admin + password + kode 2FA
3. Buka menu **Providers**
4. Edit provider `ruangotp`:
   - Set `status` = `active`
   - Set `is_default` = `1` (hanya satu provider default)
   - Isi `api_key_secret_name` dengan nama secret yang sudah di-set (mis. `RUANGOTP_API_KEY`)
5. Test koneksi via tombol "Test Connection"
6. (Opsional) Tambah provider lain dengan priority berbeda untuk failover

Setelah aktivasi, user akan lihat provider di katalog: hanya `display_name` yang muncul (mis. "Nokos.ID Server"), tanpa bocor identitas asli.

---

## VERIFIKASI PASCA-DEPLOY

Jalankan cek berikut di domain produksi Anda:

| Endpoint | Method | Auth | Expected |
|---|---|---|---|
| `/` | GET | - | 200 (landing page) |
| `/login.html` | GET | - | 200 |
| `/api/auth/register` | POST | - | 201 + CSRF token |
| `/api/otp/providers` | GET | user session | 200, body hanya `{id, display_name}` |
| `/api/admin/providers` | GET | - | 401 (tanpa session) |
| `/api/admin/stats` | GET | - | 401 (tanpa session) |

**Cek masking (penting):**

```bash
curl -s -b cookies.txt -H "X-CSRF-Token: $CSRF" \
  https://DOMAIN_ANDA/api/otp/providers
```

Response **tidak boleh** mengandung: `ruangotp`, `kirimkode`, `provider_code`, `base_url`, `api_key`.
Hanya boleh: `{"providers":[{"id":1,"display_name":"Nokos.ID Server"}]}`

---

## TROUBLESHOOTING

### Build error "Could not resolve ... src/middleware.js"
Penyebab: import path salah di file functions. Sudah diperbaiki di versi ini.
Jika muncul lagi, jalankan: `python3 scripts/fix-admin-imports.py`

### Login admin gagal "Email atau password salah"
1. Pastikan email pakai format email (bukan username) — login butuh `email`
2. Pastikan admin sudah dibuat via `scripts/create-admin.js`
3. Pastikan password yang dimasukkan sama persis saat create-admin
4. Cek hash di DB: `npx wrangler d1 execute nokos-db --command "SELECT password_hash FROM users WHERE email='admin@anda.com';"`
   Hash harus mulai dengan `$pbkdf2-sha256$210000$...`

### Login admin "Admin wajib mengaktifkan 2FA"
Admin belum setup 2FA. Lihat **LANGKAH 6c** untuk bootstrap.

### API providers return `{"providers":[]}`
Provider belum diaktivasi. Login admin → Providers → set `status=active`.
Atau via DB: `UPDATE providers SET status='active' WHERE provider_code='ruangotp';`

### Error "no such table: system_settings"
Migrasi belum dijalankan. Jalankan: `npm run db:migrate`

### Dev server lokal error "no such table"
Jalankan migrasi lokal: `npm run db:migrate:local`
Lalu boot: `npm run dev`

---

## CHECKLIST FINAL SEBELUM GO-LIVE

- [ ] Semua placeholder `PASTE_*` di `wrangler.toml` sudah diisi
- [ ] Semua secret (`JWT_SECRET`, `ENCRYPTION_KEY`, `RUANGOTP_API_KEY`, dll) sudah di-set
- [ ] Migrasi DB sukses (`npm run db:migrate`)
- [ ] Admin pertama sudah dibuat + 2FA aktif
- [ ] Deploy sukses (`npm run deploy`)
- [ ] Provider diaktivasi di panel admin
- [ ] Register user test berhasil (201 + CSRF)
- [ ] Login user test berhasil
- [ ] `/api/otp/providers` return masked (tidak bocor `provider_code`)
- [ ] `/api/admin/*` return 401 tanpa session
- [ ] Custom domain (opsional) sudah dikonfigurasi di Cloudflare Pages
- [ ] SSL/HTTPS aktif (otomatis di Cloudflare)

---

## RINGKASAN BUG YANG SUDAH DIPERBAIKI DI VERSI INI

1. **Import path ekstra `../`** di 3 file `functions/api/admin/` (audit-log.js, stats.js, providers/stats.js) — menyebabkan build error "Could not resolve"
2. **Hash password tidak match** di `scripts/create-admin.js` — pakai `deriveBits` (raw PBKDF2), padahal `verifyPassword` di `src/security.js` pakai `deriveKey→HMAC→exportKey`. Akibatnya admin yang dibuat tidak bisa login. Fixed: kedua script sekarang konsisten.
3. **Shell escaping bug** — hash PBKDF2 mengandung `$` yang di-interpretasi bash sebagai variabel saat dilewatkan via `--command`. Fixed: kedua script sekarang tulis SQL ke file temp lalu pakai `--file`.

File baru ditambahkan:
- `scripts/create-admin-cli.js` — versi non-interaktif untuk otomatisasi/CI

Test suite: **62/62 lulus** tanpa regresi.
