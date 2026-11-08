# PROVIDER_VERIFY.md — Verifikasi Path Map Provider OTP

> **WAJIB dibaca sebelum go-live.** Dokumentasi resmi setiap provider OTP berada di balik login dashboard developer. File ini mendokumentasikan status verifikasi setiap endpoint untuk **RuangOTP** dan **KirimKode** (serta template untuk provider masa depan).

## Prinsip Utama

1. **Tidak mengarang endpoint.** Adapter memakai path map dari `configuration.paths` di tabel `providers`. Default hanya diberikan untuk endpoint yang terverifikasi publik; sisanya berisi placeholder `PASTE_PATH` sampai operator memverifikasi.
2. **Path map configurable tanpa ubah kode.** Operator isi via panel admin `/admin/providers.html` (kolom "Path Map JSON") atau via Cloudflare Secret `PROVIDER_PATH_*`.
3. **Provider tidak bisa diaktifkan sebelum test koneksi berhasil** (`last_test_ok=1`). Test koneksi memanggil `getCountries()` via adapter.
4. **API key di Cloudflare Secrets**, bukan di DB. Kolom `api_key_secret_name` hanya menyimpan nama secret (mis. `RUANGOTP_API_KEY`).

## Arsitektur Adapter

Setiap provider mengimplementasikan `BaseAdapter` (`src/providers/base.js`) dengan 10 method standar:

| Method | Return normalisasi | Status |
|---|---|---|
| `getCountries()` | `[{id, name}]` | wajib |
| `getServices(country)` | `[{id, name, price?}]` | wajib |
| `getOperators(country)` | `[{id, name}]` atau `null` | opsional |
| `getPrices(country, service)` | `[{id, price}]` | wajib |
| `getAvailability(country, service, operator)` | `{available, count?}` | opsional |
| `purchaseNumber({country, service, operator}, otpOrderId)` | `{provider_order_id, phone_number}` | wajib |
| `getOrderStatus(providerOrderId, otpOrderId)` | `{status, sms?}` | wajib |
| `getOtp(providerOrderId, otpOrderId)` | alias getOrderStatus | opsional |
| `cancelOrder(providerOrderId, otpOrderId)` | `{cancelled, refund_eligible}` | opsional |
| `getBalance()` | cents IDR atau `null` | opsional |

Method yang tidak didukung provider melempar `UnsupportedError` (bukan return dummy).

## Provider 1: RuangOTP

### Status Verifikasi

| Path Key | Default | Status | Sumber |
|---|---|---|---|
| `countries` | `/country-v2/list` | ✅ Terkonfirmasi publik | Search engine index RuangOTP |
| `services` | `/service-v2/list` | ⚠️ Perlu verifikasi dashboard | Pola umum dari endpoint terkonfirmasi |
| `prices` | `/price-v2/list` | ⚠️ Perlu verifikasi dashboard | Pola umum |
| `getNumber` | `/order-v2/get-number` | ⚠️ Perlu verifikasi dashboard | Pola umum |
| `getStatus` | `/order-v2/get-status` | ⚠️ Perlu verifikasi dashboard | Pola umum |
| `setStatus` | `/order-v2/set-status` | ⚠️ Perlu verifikasi dashboard | Pola umum |
| `orderHistory` | `/order-v2/history` | ⚠️ Perlu verifikasi dashboard | Pola umum |
| `getBalance` | `/balance-v2` | ⚠️ Perlu verifikasi dashboard | Pola umum |

### Autentikasi

Tiga mode didukung (atur `auth_method` di panel admin):
- **bearer** (default): header `Authorization: Bearer <api_key>`
- **query**: `?api_key=<key>` (set `auth_in_query_param=api_key`)
- **header**: header kustom (set `auth_header_name=X-API-Key`)

### Langkah Aktivasi RuangOTP

1. Login dashboard RuangOTP → buka halaman dokumentasi API.
2. Catat **base_url** dan **path** persis untuk setiap action.
3. Set Cloudflare Secret:
   ```bash
   npx wrangler pages secret put RUANGOTP_API_KEY
   ```
4. Buka `/admin/providers.html` → Edit "RuangOTP" → isi `base_url`, pastikan `api_key_secret_name = RUANGOTP_API_KEY`, sesuaikan path map bila berbeda dari default.
5. Klik **Test** → bila OK, klik **Aktifkan**.
6. Uji: `curl -H "Cookie: nokos_sid=<session>" https://nokos.id/api/otp/countries?provider=ruangotp`

## Provider 2: KirimKode

### ⚠️ Status Verifikasi: BELUM TERVERIFIKASI

Dokumentasi API KirimKode **tidak ditemukan** di sumber publik yang terverifikasi saat pembuatan file ini. Sesuai master prompt BAGIAN 17.C ("Jangan mengarang endpoint KirimKode"), seed provider KirimKode di migration 0003 berisi **placeholder `PASTE_PATH`** untuk semua endpoint. Provider **TIDAK bisa diaktifkan** sampai:

1. Anda login ke dashboard developer KirimKode.
2. Mencatat base_url resmi.
3. Mencatat path untuk setiap action.
4. Mengisi path map di panel admin (atau via Cloudflare Secret).
5. Set Cloudflare Secret `KIRIMKODE_API_KEY`.
6. Test koneksi berhasil.

### Path Map (placeholder — isi dari dashboard KirimKode)

```json
{
  "paths": {
    "countries": "PASTE_PATH",
    "services": "PASTE_PATH",
    "prices": "PASTE_PATH",
    "getNumber": "PASTE_PATH",
    "getStatus": "PASTE_PATH",
    "setStatus": "PASTE_PATH",
    "orderHistory": "PASTE_PATH",
    "getBalance": "PASTE_PATH"
  }
}
```

Adapter `KirimKodeAdapter` (`src/providers/kirimkode.js`) memakai parser toleran yang sama dengan RuangOTP (JSON modern + string sms-activate), jadi setelah path map diverifikasi, adapter akan berfungsi tanpa ubah kode.

### Bila KirimKode memakai format response berbeda

Bila response KirimKode tidak cocok dengan parser default (JSON `{id, number}` atau string `ACCESS_NUMBER:id:number`), override method di `KirimKodeAdapter`:

```js
async purchaseNumber({country, service, operator}, otpOrderId) {
  this._ensureConfigured("getNumber");
  const r = await this._call("getNumber", "getNumber", {country, service, operator}, {otpOrderId});
  // parse sesuai format KirimKode yang sebenarnya
  const data = r.data;
  return { provider_order_id: data.kode_unik, phone_number: data.nomor };
}
```

## Menambahkan Provider Baru

Template untuk provider ke-3 dan seterusnya:

1. **Buat adapter** `src/providers/namaprovider.js`:
   ```js
   import { BaseAdapter } from "./base.js";
   export class NamaProviderAdapter extends BaseAdapter {
     paths() {
       return this.config.configuration?.paths || { countries: "/...", getNumber: "/...", /* dst */ };
     }
     async getCountries() { const r = await this._call("getCountries","countries",{}); return normalizeList(r.data); }
     // implementasi method lain
   }
   ```
2. **Daftarkan** di `src/providers/registry.js` `ADAPTERS` map.
3. **Buat provider** via panel admin (`/admin/providers.html`) dengan `provider_code` yang cocok.
4. **Set Cloudflare Secret** untuk API key.
5. **Test koneksi** → aktivasi.

## Parser Response (toleran)

Adapter BaseAdapter menyediakan `parseSmsActivateString()` untuk format umum:
- `ACCESS_NUMBER:<providerId>:<number>` → sukses beli nomor
- `STATUS_OK:<sms>` → OTP diterima
- `STATUS_WAIT_CODE` → menunggu OTP
- `STATUS_CANCEL` → order dibatalkan
- `NO_NUMBERS`, `NO_BALANCE`, `BAD_KEY`, `WRONG_SERVICE` → error standar

Bila provider memakai JSON modern (`{id, number, status}`), parser JSON default di setiap adapter menanganinya.

## Logging & Audit

Setiap panggilan provider dicatat di tabel `provider_logs`:
- `action` — nama method (getCountries, getNumber, dst)
- `http_status`, `error_code`, `duration_ms`
- `redacted_meta` — JSON request (TANPA api_key)
- `redacted_response` — JSON response dipotong (TANPA secret)
- `success` — boolean

**Tidak ada api_key, password, atau OTP pengguna yang dicatat.** Cek dengan:
```sql
SELECT * FROM provider_logs ORDER BY created_at DESC LIMIT 20;
```

## Troubleshooting Provider

| Gejala | Penyebab | Solusi |
|---|---|---|
| `PATH_NOT_CONFIGURED` | Path map berisi `PASTE_PATH` | Isi path map di panel admin dari dashboard provider |
| `API_KEY_MISSING` | Secret belum di-set | `wrangler pages secret put <NAMA_SECRET>` |
| `PROVIDER_INACTIVE` | Status provider belum `active` | Test koneksi dulu, lalu aktivasi via panel admin |
| `TEST_REQUIRED` | Mau set `active` tapi `last_test_ok=0` | Klik tombol Test di panel admin |
| `PROVIDER_TIMEOUT` | Provider tidak merespons dalam `timeout_ms` | Cek status provider eksternal, naikkan `timeout_ms` bila perlu |
| `PURCHASE_FAILED` / `NO_NUMBERS` | Provider tidak punya nomor untuk layanan itu | Coba layanan/negara lain atau provider lain |
| `BAD_KEY` | API key salah / expired | Rotasi API key di dashboard provider, update Secret |

## Yang TIDAK Dilakukan (kepatuhan)

- ❌ Tidak ada endpoint yang dikarang dengan path asal-asalan. Default hanya untuk yang terverifikasi.
- ❌ Tidak ada response yang dipalsukan. Bila provider error, error dilempar ke user.
- ❌ Tidak ada API key yang di-log (audit log hanya catat `endpoint` + `provider_order_id`).
- ❌ Tidak ada provider yang otomatis diaktifkan tanpa test koneksi.
- ❌ Tidak ada double-purchase lintas provider (idempotency_key per order + `provider_order_id` UNIQUE per provider).
- ❌ **Hidden Provider System**: tidak ada `provider_code`, `provider_name`, `base_url`, `api_key_secret_name`, `provider_order_id`, atau `provider_cost_cents` yang di-return ke API publik (`/api/otp/*`).
- ❌ Tidak ada nama provider asli yang muncul di notifikasi user, pesan error, atau HTML/JS frontend.
- ❌ Tidak ada bypass masking via frontend (masking di backend response, bukan CSS hide).
- ❌ Tidak ada `provider_code` yang dikirim via query param publik — `?provider=` menerima ID internal (angka) saja.

## Hidden Provider System — Catatan Implementasi

Identitas provider asli (RuangOTP, KirimKode) hanya tampil di Admin Panel (RBAC protected). Di user-facing:

- `display_name` (kolom di tabel `providers`, migration 0004) menjadi satu-satunya nama yang user lihat ("Nokos.ID Server", "Server 1", dst).
- `provider_code` tetap sebagai key internal adapter registry — **tidak pernah** dikirim ke client.
- Pesan error di-sanitize via `sanitizeForUser()` sebelum dikirim (lihat `src/public-view.js`).
- Detail internal (provider_code asli, provider_order_id, alasan error) tetap ada di `wallet_audit_logs` + `provider_logs` — hanya admin yang bisa akses via `/api/admin/*`.

**Aturan untuk display_name**: admin JANGAN mengisi nama provider asli (mis. "RuangOTP") di field display_name. Default otomatis: `is_default=1` → "Nokos.ID Server", else "Server N". Admin bebas ganti ke nama brand-neutral lain ("Server Premium", "Server Jakarta").

