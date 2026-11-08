// src/providers/ruangotp.js — Adapter RuangOTP (implements BaseAdapter)
//
// Kontrak: getCountries, getServices, getPrices, getAvailability (via getNumber),
// purchaseNumber, getOrderStatus, cancelOrder, getBalance.
//
// ⚠️ Dokumentasi resmi (ruangotp.io/api/dev) di balik login dashboard.
// Hanya endpoint /country-v2/list yang terverifikasi publik. Path lain
// memakai pola umum dari endpoint tersebut dan dapat di-override via
// configuration.paths di tabel providers (lihat migration 0003 + PROVIDER_VERIFY.md).
//
// Response parser toleran: JSON modern {id, number} atau string sms-activate.

import { BaseAdapter, ProviderError, parseSmsActivateString } from "./base.js";

export class RuangOTPAdapter extends BaseAdapter {
  // Path map: priority configuration.paths → fallback ke default pola -v2/list
  paths() {
    return this.config.configuration?.paths || {
      countries: "/country-v2/list",
      services: "/service-v2/list",
      prices: "/price-v2/list",
      getNumber: "/order-v2/get-number",
      getStatus: "/order-v2/get-status",
      setStatus: "/order-v2/set-status",
      orderHistory: "/order-v2/history",
      getBalance: "/balance-v2",
    };
  }

  async getCountries() {
    const r = await this._call("getCountries", "countries", {});
    return normalizeList(r.data, "countries");
  }

  async getServices(country) {
    const params = country ? { country } : {};
    const r = await this._call("getServices", "services", params);
    return normalizeList(r.data, "services");
  }

  async getOperators(country) {
    // RuangOTP tidak expose operator terpisah di endpoint publik → unsupported
    try {
      const r = await this._call("getOperators", "operators", country ? { country } : {});
      if (!r.ok) return null;
      return normalizeList(r.data, "operators");
    } catch (e) {
      if (e.code === "PATH_NOT_CONFIGURED") return null;
      throw e;
    }
  }

  async getPrices(country, service) {
    const params = {};
    if (country) params.country = country;
    if (service) params.service = service;
    const r = await this._call("getPrices", "prices", params);
    return normalizeList(r.data, "prices");
  }

  async getAvailability(country, service, operator) {
    // Tidak ada endpoint stok terpisah → baca dari prices (bila ada field count)
    const prices = await this.getPrices(country, service);
    if (!Array.isArray(prices) || prices.length === 0) return { available: false };
    const match = prices.find((p) => String(p.service_code || p.id) === String(service));
    return { available: !!match, count: match?.count };
  }

  async purchaseNumber({ country, service, operator }, otpOrderId) {
    const params = { country, service };
    if (operator) params.operator = operator;
    const r = await this._call("getNumber", "getNumber", params, { otpOrderId });
    const parsed = parsePurchaseResponse(r.data);
    if (!parsed.ok) {
      throw new ProviderError(parsed.reason || "Provider tidak memberikan nomor", {
        code: parsed.reason || "PURCHASE_FAILED",
        providerCode: this.code,
      });
    }
    return { provider_order_id: parsed.providerOrderId, phone_number: parsed.number };
  }

  async getOrderStatus(providerOrderId, otpOrderId) {
    const r = await this._call("getStatus", "getStatus", { id: providerOrderId }, { otpOrderId });
    const parsed = parseStatusResponse(r.data);
    return {
      status: parsed.cancelled ? "cancelled" : parsed.sms ? "completed" : "pending",
      sms: parsed.sms,
    };
  }

  async cancelOrder(providerOrderId, otpOrderId) {
    // sms-activate style: setStatus=8 (cancel)
    const r = await this._call("setStatus", "setStatus", { id: providerOrderId, status: 8 }, { otpOrderId, method: "POST" });
    const text = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    return {
      cancelled: /ACCESS_RETRY_READY|STATUS_OK|CANCEL/i.test(text) || r.ok,
      refund_eligible: true,
    };
  }

  async getBalance() {
    try {
      const r = await this._call("getBalance", "getBalance", {});
      return parseBalanceResponse(r.data);
    } catch (e) {
      if (e.code === "PATH_NOT_CONFIGURED" || e.code === "UNSUPPORTED") return null;
      throw e;
    }
  }
}

// ---- Normalizer helpers ----------------------------------------------

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
    const name = item.name ?? item.country ?? item.service_name ?? item.ru ?? item.title ?? id;
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
    const bal = data.balance ?? data.balance_rub ?? data.amount;
    if (bal !== undefined) return Math.round(parseFloat(bal) * 100);
  }
  return null;
}

// ---- Backward-compat exports (untuk kode lama yang import langsung) --
// Deprecated: pakai registry.getAdapter(env, provider_code) sebagai gantinya.
export async function listCountries(env) {
  const { getAdapter } = await import("./registry.js");
  const adapter = await getAdapter(env, "ruangotp");
  return adapter.getCountries();
}
export async function listServices(env, country) {
  const { getAdapter } = await import("./registry.js");
  const a = await getAdapter(env, "ruangotp");
  return a.getServices(country);
}
export async function listPrices(env, country, service) {
  const { getAdapter } = await import("./registry.js");
  const a = await getAdapter(env, "ruangotp");
  return a.getPrices(country, service);
}
export async function getNumber(env, otpOrderId, opts) {
  const { getAdapter } = await import("./registry.js");
  const a = await getAdapter(env, "ruangotp");
  return a.purchaseNumber(opts, otpOrderId);
}
export async function getStatus(env, otpOrderId, providerOrderId) {
  const { getAdapter } = await import("./registry.js");
  const a = await getAdapter(env, "ruangotp");
  return a.getOrderStatus(providerOrderId, otpOrderId);
}
export async function setStatus(env, otpOrderId, providerOrderId, status) {
  const { getAdapter } = await import("./registry.js");
  const a = await getAdapter(env, "ruangotp");
  // status int → map ke cancel bila 8
  if (status === 8) return a.cancelOrder(providerOrderId, otpOrderId);
  return { cancelled: false };
}
export async function orderHistory(env, otpOrderId, providerOrderId) {
  return null; // tidak didukung via interface
}
