// src/providers/kirimkode.js — Adapter KirimKode (implements BaseAdapter)
//
// ⚠️ PENTING: dokumentasi API KirimKode tidak terverifikasi secara publik
// (di balik login dashboard developer). Sesuai master prompt BAGIAN 17.C:
// "Jangan mengarang endpoint KirimKode."
//
// Adapter ini memakai path map dari configuration.paths di tabel providers,
// yang semuanya berisi placeholder "PASTE_PATH" pada seed. Provider TIDAK
// bisa diaktifkan sebelum:
//   1. base_url diisi (dari dashboard KirimKode)
//   2. path map di-isi / diverifikasi (lihat PROVIDER_VERIFY.md)
//   3. api_key_secret_name dikonfigurasi via Cloudflare Secret KIRIMKODE_API_KEY
//   4. Test koneksi berhasil via /api/admin/providers/:id/test
//
// Setelah path map diverifikasi, adapter ini akan berfungsi sama seperti
// RuangOTP — base class menyediakan HTTP call, retry, logging.
// Parser toleran (JSON modern + string sms-activate) sudah ada di BaseAdapter.
//
// Bila KirimKode memakai format response yang berbeda, override method
// di kelas ini setelah verifikasi.

import { BaseAdapter, ProviderError, parseSmsActivateString } from "./base.js";

export class KirimKodeAdapter extends BaseAdapter {
  paths() {
    const p = this.config.configuration?.paths || {};
    // bila masih placeholder, lempar error jelas saat dipanggil
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === "string" && /PASTE/i.test(v)) {
        // path belum dikonfigurasi — method akan gagal dengan jelas
      }
    }
    return p;
  }

  _ensureConfigured(method) {
    const p = this.paths()[method] || this.paths()[this._pathKeyFor(method)];
    if (typeof p === "string" && /PASTE/i.test(p)) {
      throw new ProviderError(
        `Path untuk '${method}' belum dikonfigurasi untuk provider KirimKode. ` +
          `Login dashboard KirimKode → dokumentasi API → isi configuration.paths di tabel providers (atau via panel admin). Lihat PROVIDER_VERIFY.md.`,
        { code: "PATH_NOT_CONFIGURED", providerCode: this.code },
      );
    }
    if (!p) {
      throw new ProviderError(
        `Path '${method}' tidak ditemukan untuk KirimKode. Isi configuration.paths.`,
        { code: "PATH_NOT_CONFIGURED", providerCode: this.code },
      );
    }
  }

  _pathKeyFor(method) {
    const map = {
      getCountries: "countries",
      getServices: "services",
      getPrices: "prices",
      getAvailability: "availability",
      purchaseNumber: "getNumber",
      getOrderStatus: "getStatus",
      getOtp: "getStatus",
      cancelOrder: "setStatus",
      getBalance: "getBalance",
    };
    return map[method] || method;
  }

  async getCountries() {
    this._ensureConfigured("countries");
    const r = await this._call("getCountries", "countries", {});
    return normalizeList(r.data, "countries");
  }

  async getServices(country) {
    this._ensureConfigured("services");
    const params = country ? { country } : {};
    const r = await this._call("getServices", "services", params);
    return normalizeList(r.data, "services");
  }

  async getOperators(country) {
    try {
      this._ensureConfigured("operators");
    } catch (e) {
      return null; // operator optional
    }
    const r = await this._call("getOperators", "operators", country ? { country } : {});
    return r.ok ? normalizeList(r.data, "operators") : null;
  }

  async getPrices(country, service) {
    this._ensureConfigured("prices");
    const params = {};
    if (country) params.country = country;
    if (service) params.service = service;
    const r = await this._call("getPrices", "prices", params);
    return normalizeList(r.data, "prices");
  }

  async getAvailability(country, service, operator) {
    // Coba endpoint availability bila ada; fallback ke prices
    try {
      this._ensureConfigured("availability");
      const params = { country, service };
      if (operator) params.operator = operator;
      const r = await this._call("getAvailability", "availability", params);
      const data = r.data;
      return {
        available: !!((typeof data === "object" && (data.available ?? data.count > 0)) || data === "available"),
        count: typeof data === "object" ? data.count : undefined,
      };
    } catch (e) {
      if (e.code !== "PATH_NOT_CONFIGURED") throw e;
    }
    // fallback: baca dari prices
    const prices = await this.getPrices(country, service);
    if (!Array.isArray(prices) || prices.length === 0) return { available: false };
    return { available: true };
  }

  async purchaseNumber({ country, service, operator }, otpOrderId) {
    this._ensureConfigured("getNumber");
    const params = { country, service };
    if (operator) params.operator = operator;
    const r = await this._call("getNumber", "getNumber", params, { otpOrderId });
    const parsed = parsePurchaseResponse(r.data);
    if (!parsed.ok) {
      throw new ProviderError(parsed.reason || "KirimKode tidak memberikan nomor", {
        code: parsed.reason || "PURCHASE_FAILED",
        providerCode: this.code,
      });
    }
    return { provider_order_id: parsed.providerOrderId, phone_number: parsed.number };
  }

  async getOrderStatus(providerOrderId, otpOrderId) {
    this._ensureConfigured("getStatus");
    const r = await this._call("getStatus", "getStatus", { id: providerOrderId }, { otpOrderId });
    const parsed = parseStatusResponse(r.data);
    return {
      status: parsed.cancelled ? "cancelled" : parsed.sms ? "completed" : "pending",
      sms: parsed.sms,
    };
  }

  async cancelOrder(providerOrderId, otpOrderId) {
    this._ensureConfigured("setStatus");
    const r = await this._call("setStatus", "setStatus", { id: providerOrderId, action: "cancel" }, { otpOrderId, method: "POST" });
    return { cancelled: r.ok, refund_eligible: r.ok };
  }

  async getBalance() {
    try {
      this._ensureConfigured("getBalance");
    } catch (e) {
      if (e.code === "PATH_NOT_CONFIGURED") return null;
      throw e;
    }
    const r = await this._call("getBalance", "getBalance", {});
    return parseBalanceResponse(r.data);
  }
}

// ---- Normalizer helpers (sama pola dengan RuangOTP) -----------------

function normalizeList(data, kind) {
  if (!data) return [];
  if (Array.isArray(data)) return data.map(normalizeItem);
  if (typeof data === "object") {
    for (const key of ["data", kind, "list", "items", "results"]) {
      if (Array.isArray(data[key])) return data[key].map(normalizeItem);
    }
  }
  return [];
}

function normalizeItem(item) {
  if (typeof item === "string") return { id: item, name: item };
  if (typeof item === "object") {
    const id = item.id ?? item.code ?? item.country_id ?? item.service ?? item.service_code;
    const name = item.name ?? item.country ?? item.service_name ?? item.title ?? id;
    const price = item.price ?? item.cost ?? item.amount ?? item.price_cents;
    return { id: String(id), name: String(name), ...(price !== undefined ? { price } : {}), ...item };
  }
  return { id: String(item), name: String(item) };
}

function parsePurchaseResponse(data) {
  if (!data) return { ok: false, reason: "Empty response" };
  if (typeof data === "string") {
    const smsStyle = parseSmsActivateString(data);
    if (smsStyle?.ok && smsStyle.providerOrderId) {
      return { ok: true, providerOrderId: smsStyle.providerOrderId, number: smsStyle.number };
    }
    if (smsStyle && !smsStyle.ok) return { ok: false, reason: smsStyle.reason };
    return { ok: false, reason: data.slice(0, 200) };
  }
  if (typeof data === "object") {
    if (data.id && (data.number || data.phone)) {
      return { ok: true, providerOrderId: String(data.id), number: String(data.number || data.phone) };
    }
    if (data.error || data.message) {
      return { ok: false, reason: String(data.error || data.message).slice(0, 200) };
    }
    if (data.data?.id) {
      return { ok: true, providerOrderId: String(data.data.id), number: String(data.data.number || data.data.phone) };
    }
  }
  return { ok: false, reason: "Format respons tidak dikenal" };
}

function parseStatusResponse(data) {
  if (!data) return { sms: null, cancelled: false };
  if (typeof data === "string") {
    const s = parseSmsActivateString(data);
    if (s?.ok) {
      if (s.sms) return { sms: s.sms };
      if (s.cancelled) return { cancelled: true };
      return { sms: null };
    }
    return { sms: null };
  }
  if (typeof data === "object") {
    if (data.code || data.sms || data.otp) return { sms: String(data.code || data.sms || data.otp) };
    if (data.status === "cancelled" || data.status === "canceled") return { cancelled: true };
    if (data.status === "waiting") return { sms: null };
    if (data.data?.code) return { sms: String(data.data.code) };
  }
  return { sms: null };
}

function parseBalanceResponse(data) {
  if (typeof data === "string") {
    const m = data.match(/(\d+(?:\.\d+)?)/);
    if (m) return Math.round(parseFloat(m[1]) * 100);
    return null;
  }
  if (typeof data === "object") {
    const bal = data.balance ?? data.amount ?? data.credit;
    if (bal !== undefined) return Math.round(parseFloat(bal) * 100);
  }
  return null;
}
