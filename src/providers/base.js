// src/providers/base.js — BaseAdapter: kontrak untuk semua provider OTP.
//
// Master prompt BAGIAN 17.D mensyaratkan interface standar:
//   getCountries(), getServices(), getOperators(), getPrices(),
//   getAvailability(), purchaseNumber(), getOrderStatus(),
//   getOtp(), cancelOrder(), getBalance()
//
// Setiap adapter wajib mengimplementasikan method yang DIDUKUNG provider.
// Method yang tidak didukung melempar UnsupportedError (bukan return dummy).
//
// Response setiap method dinormalisasi ke format internal Nokos.ID
// (lihat komentar di tiap method).
//
// Tidak ada API key yang disimpan di sini — diambil dari env via secret name.

import { now } from "../utils.js";
import { run } from "../db.js";

export class UnsupportedError extends Error {
  constructor(method, provider) {
    super(`Provider '${provider}' tidak mendukung method '${method}'`);
    this.name = "UnsupportedError";
    this.code = "UNSUPPORTED";
  }
}

export class ProviderError extends Error {
  constructor(message, { code, httpStatus, providerCode } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code || "PROVIDER_ERROR";
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
  }
}

export class TimeoutError extends Error {
  constructor(message, providerCode) {
    super(message);
    this.name = "TimeoutError";
    this.code = "PROVIDER_TIMEOUT";
    this.providerCode = providerCode;
  }
}

/**
 * @typedef {Object} ProviderConfig
 * @property {number} id
 * @property {string} provider_code
 * @property {string} provider_name
 * @property {string} base_url
 * @property {string} auth_method - 'bearer'|'query'|'header'
 * @property {string} [auth_header_name]
 * @property {string} api_key_secret_name
 * @property {string} [auth_in_query_param]
 * @property {string} status
 * @property {number} priority
 * @property {number} markup_percent
 * @property {number} timeout_ms
 * @property {number} max_retries
 * @property {Object} configuration - parsed JSON (path map, dll)
 */

export class BaseAdapter {
  /**
   * @param {ProviderConfig} config - baris dari tabel providers
   * @param {Object} env - Cloudflare env (untuk ambil secret via nama)
   */
  constructor(config, env) {
    this.config = config;
    this.env = env;
    this.code = config.provider_code;
    this.name = config.provider_name;
  }

  /** Ambil API key dari env via nama secret. */
  getApiKey() {
    const name = this.config.api_key_secret_name;
    const key = this.env[name];
    if (!key) {
      throw new ProviderError(
        `API key secret '${name}' belum dikonfigurasi untuk provider '${this.code}'`,
        { code: "API_KEY_MISSING", providerCode: this.code },
      );
    }
    return key;
  }

  /** Path map dari configuration (JSON). Override bila perlu. */
  paths() {
    return this.config.configuration?.paths || {};
  }

  /**
   * HTTP call dengan timeout, retry, dan logging ke provider_logs.
   * Tidak mencatat api_key.
   */
  async _call(action, pathKey, params, opts = {}) {
    const apiKey = this.getApiKey();
    const paths = this.paths();
    const path = paths[pathKey];
    if (!path) {
      throw new ProviderError(
        `Path '${pathKey}' tidak dikonfigurasi untuk provider '${this.code}'`,
        { code: "PATH_NOT_CONFIGURED", providerCode: this.code },
      );
    }
    const url = new URL(this.config.base_url.replace(/\/+$/, "") + path);
    const headers = { Accept: "application/json", "User-Agent": `NokosID/2.0 (${this.code})` };

    if (this.config.auth_method === "bearer") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (this.config.auth_method === "header") {
      headers[this.config.auth_header_name || "X-API-Key"] = apiKey;
    } else if (this.config.auth_method === "query") {
      url.searchParams.set(this.config.auth_in_query_param || "api_key", apiKey);
    }

    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const reqMeta = { action, path, method: opts.method || "GET", params: redact(params) };
    const start = Date.now();
    let lastErr = null;

    for (let attempt = 1; attempt <= this.config.max_retries + 1; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeout_ms);
      try {
        const res = await fetch(url.toString(), {
          method: opts.method || "GET",
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        const duration = Date.now() - start;
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 2000); }
        await this._log(action, opts.otpOrderId, reqMeta, parsed, res.status, duration, res.ok);
        return { ok: res.ok, status: res.status, data: parsed, raw: text, duration };
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (e.name === "AbortError") {
          // timeout → jangan retry otomatis (sesuai master prompt)
          await this._log(action, opts.otpOrderId, reqMeta, { error: "timeout" }, 0, Date.now() - start, false);
          throw new TimeoutError(`Provider '${this.code}' timeout setelah ${this.config.timeout_ms}ms`, this.code);
        }
        if (attempt > this.config.max_retries) break;
        await sleep(300 * attempt);
      }
    }
    await this._log(action, opts.otpOrderId, reqMeta, { error: String(lastErr?.message || lastErr) }, 0, Date.now() - start, false);
    throw new ProviderError(`Gagal memanggil provider '${this.code}': ${lastErr?.message || "unknown"}`, {
      code: "PROVIDER_UNREACHABLE",
      providerCode: this.code,
    });
  }

  async _log(action, otpOrderId, reqMeta, responseRaw, httpStatus, durationMs, success) {
    if (!this.env.DB) return;
    try {
      await run(
        this.env.DB,
        `INSERT INTO provider_logs (provider_id, otp_order_id, request_reference, action, http_status, error_code, duration_ms, redacted_meta, redacted_response, success, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.config.id,
          otpOrderId || null,
          reqMeta.reference || null,
          action,
          httpStatus || null,
          (responseRaw && responseRaw.error) ? String(responseRaw.error).slice(0, 100) : null,
          durationMs,
          JSON.stringify(reqMeta).slice(0, 1000),
          (typeof responseRaw === "string" ? responseRaw : JSON.stringify(responseRaw)).slice(0, 4000),
          success ? 1 : 0,
          now(),
        ],
      );
    } catch {
      // log failure jangan crash flow utama
    }
  }

  // ---- Method standar (override di subclass) -------------------------

  /** @returns {Promise<Array<{id,name}>|null>} null bila tidak didukung */
  async getCountries() { throw new UnsupportedError("getCountries", this.code); }

  /**
   * @returns {Promise<Array<{service_code,service_name,country_code?}>|null>}
   */
  async getServices(country) { throw new UnsupportedError("getServices", this.code); }

  /** @returns {Promise<Array<{operator_code,operator_name}>|null>} */
  async getOperators(country) { throw new UnsupportedError("getOperators", this.code); }

  /**
   * @returns {Promise<Array<{service_code,country_code,price_cents,currency}>|null>}
   */
  async getPrices(country, service) { throw new UnsupportedError("getPrices", this.code); }

  /**
   * @returns {Promise<{available:boolean,count?:number}|null>}
   */
  async getAvailability(country, service, operator) { throw new UnsupportedError("getAvailability", this.code); }

  /**
   * Beli nomor. Return normalisasi:
   *   { provider_order_id, phone_number }
   * @returns {Promise<{provider_order_id:string, phone_number:string}>}
   */
  async purchaseNumber({ country, service, operator }, otpOrderId) {
    throw new UnsupportedError("purchaseNumber", this.code);
  }

  /**
   * Cek status order. Return normalisasi:
   *   { status: 'pending'|'active'|'completed'|'cancelled'|'failed', sms?:string }
   */
  async getOrderStatus(providerOrderId, otpOrderId) { throw new UnsupportedError("getOrderStatus", this.code); }

  /** Alias getOrderStatus untuk OTP spesifik. */
  async getOtp(providerOrderId, otpOrderId) {
    return this.getOrderStatus(providerOrderId, otpOrderId);
  }

  /** Batal order. Return { cancelled: boolean, refund_eligible: boolean }. */
  async cancelOrder(providerOrderId, otpOrderId) { throw new UnsupportedError("cancelOrder", this.code); }

  /** Saldo akun provider (bila didukung). Return cents IDR atau null. */
  async getBalance() { throw new UnsupportedError("getBalance", this.code); }

  /** Test koneksi: panggil endpoint ringan (getCountries) untuk verifikasi. */
  async testConnection() {
    try {
      const data = await this.getCountries();
      return { ok: true, sample: Array.isArray(data) ? data.slice(0, 2) : data };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code };
    }
  }
}

function redact(params) {
  const out = { ...(params || {}) };
  delete out.api_key;
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parser helper: response gaya sms-activate string. */
export function parseSmsActivateString(str) {
  if (typeof str !== "string") return null;
  const m = str.match(/^ACCESS_NUMBER:(\w+):(\+?\d+)$/);
  if (m) return { ok: true, providerOrderId: m[1], number: m[2] };
  if (/NO_NUMBERS/i.test(str)) return { ok: false, reason: "NO_NUMBERS" };
  if (/NO_BALANCE/i.test(str)) return { ok: false, reason: "NO_BALANCE" };
  if (/BAD_KEY|WRONG_KEY|BAD_ACTION/i.test(str)) return { ok: false, reason: "BAD_KEY" };
  if (/WRONG_SERVICE/i.test(str)) return { ok: false, reason: "WRONG_SERVICE" };
  if (/BAD_KEY|WRONG_KEY|NO_KEY/i.test(str)) return { ok: false, reason: "BAD_KEY" };
  const status = str.match(/^STATUS_(\w+)(?::(.+))?$/);
  if (status) {
    if (status[1] === "OK") return { ok: true, sms: status[2] };
    if (status[1] === "WAIT" || status[1] === "WAIT_CODE") return { ok: true, sms: null };
    if (status[1] === "CANCEL") return { ok: true, cancelled: true };
  }
  return null;
}
