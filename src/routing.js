// src/routing.js — Smart Provider Routing
//
// Mode (master prompt 17.F):
//   1. manual       — user pilih provider_code tertentu
//   2. cheapest     — pilih harga jual terendah
//   3. priority     — pilih provider aktif dengan priority ASC (is_default dulu)
//   4. availability — pilih provider yang punya nomor tersedia
//
// Ketentuan:
//   - Provider harus status='active'
//   - Harga valid (positive int)
//   - Layanan + negara tersedia di provider itu
//   - Bila gagal di satu provider, JANGAN otomatis pindah ke provider lain
//     setelah nomor berhasil diterbitkan (master prompt 17.F)
//
// resolveProvider(env, { mode, provider_code, country, service, operator }):
//   returns { adapter, providerConfig, sellPrice, providerCostCents }

import { first, all } from "./db.js";
import { getAdapter } from "./providers/registry.js";
import { ProviderError } from "./providers/base.js";

const MODES = new Set(["manual", "cheapest", "priority", "availability"]);

/**
 * Hitung harga jual dari harga provider + markup per-provider.
 */
export function computeSellPrice(providerCostCents, markupPercent) {
  if (!providerCostCents || providerCostCents <= 0) return 0;
  const markup = Math.ceil((providerCostCents * (markupPercent || 0)) / 100);
  return providerCostCents + markup;
}

/**
 * Resolve provider berdasarkan mode.
 * @returns {Promise<{adapter, providerConfig, sellPrice, providerCostCents}>}
 */
export async function resolveProvider(env, opts) {
  const mode = opts.mode || "priority";
  if (!MODES.has(mode)) {
    throw Object.assign(new Error(`Mode routing tidak valid: ${mode}`), { code: "INVALID_MODE" });
  }

  const activeProviders = await all(
    env.DB,
    `SELECT * FROM providers WHERE status='active' ORDER BY priority ASC, is_default DESC`,
  );

  if (activeProviders.length === 0) {
    throw new ProviderError("Tidak ada provider aktif.", { code: "NO_ACTIVE_PROVIDER" });
  }

  // parse configuration per provider
  for (const p of activeProviders) {
    try { p.configuration = JSON.parse(p.configuration || "{}"); } catch { p.configuration = {}; }
  }

  if (mode === "manual") {
    // Hidden Provider System: ?provider= dari user adalah ID internal (angka),
    // BUKAN provider_code. Mapping internal saja, user tidak pernah tahu code asli.
    if (!opts.provider_id) {
      throw Object.assign(new Error("mode=manual wajib pilih server"), { code: "VALIDATION" });
    }
    const cfg = activeProviders.find((p) => p.id === Number(opts.provider_id));
    if (!cfg) {
      throw new ProviderError("Server yang dipilih tidak aktif atau tidak ditemukan", {
        code: "PROVIDER_INACTIVE",
      });
    }
    const adapter = await getAdapter(env, cfg.id);
    const price = await fetchPrice(adapter, opts.country, opts.service);
    return wrapResult(adapter, cfg, price);
  }

  if (mode === "priority") {
    // coba tiap provider sesuai urutan, ambil yang pertama berhasil kasih harga
    for (const cfg of activeProviders) {
      try {
        const adapter = await getAdapter(env, cfg.id);
        const price = await fetchPrice(adapter, opts.country, opts.service);
        if (price > 0) return wrapResult(adapter, cfg, price);
      } catch (e) {
        // log & lanjut ke provider berikutnya
        continue;
      }
    }
    throw new ProviderError("Tidak ada provider yang bisa memberikan harga untuk layanan ini.", {
      code: "NO_PRICE_AVAILABLE",
    });
  }

  if (mode === "cheapest") {
    // kumpulkan harga dari semua provider aktif, ambil termurah
    const candidates = [];
    for (const cfg of activeProviders) {
      try {
        const adapter = await getAdapter(env, cfg.id);
        const price = await fetchPrice(adapter, opts.country, opts.service);
        if (price > 0) candidates.push({ adapter, cfg, price });
      } catch {
        continue;
      }
    }
    if (candidates.length === 0) {
      throw new ProviderError("Tidak ada provider yang memberikan harga.", { code: "NO_PRICE_AVAILABLE" });
    }
    candidates.sort((a, b) => sellFor(a) - sellFor(b));
    const best = candidates[0];
    return wrapResult(best.adapter, best.cfg, best.price);
  }

  if (mode === "availability") {
    // cek availability tiap provider, ambil yang available=true dengan priority tertinggi
    for (const cfg of activeProviders) {
      try {
        const adapter = await getAdapter(env, cfg.id);
        const avail = await adapter.getAvailability(opts.country, opts.service, opts.operator);
        if (avail?.available) {
          const price = await fetchPrice(adapter, opts.country, opts.service);
          return wrapResult(adapter, cfg, price);
        }
      } catch {
        continue;
      }
    }
    throw new ProviderError("Tidak ada provider dengan nomor tersedia untuk layanan ini.", {
      code: "NO_AVAILABILITY",
    });
  }
}

async function fetchPrice(adapter, country, service) {
  try {
    const prices = await adapter.getPrices(country, service);
    if (!Array.isArray(prices) || prices.length === 0) return 0;
    const match = prices.find((p) => String(p.service_code || p.id) === String(service)) || prices[0];
    const p = match.price ?? match.price_cents ?? match.cost ?? match.amount;
    return Number(p) || 0;
  } catch {
    return 0;
  }
}

function sellFor(c) {
  return computeSellPrice(c.price, c.cfg.markup_percent);
}

function wrapResult(adapter, cfg, providerCostCents) {
  return {
    adapter,
    providerConfig: cfg,
    providerCostCents: providerCostCents,
    sellPrice: computeSellPrice(providerCostCents, cfg.markup_percent),
    providerId: cfg.id,
    providerCode: cfg.provider_code,
  };
}
