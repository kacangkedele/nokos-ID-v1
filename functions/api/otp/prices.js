// functions/api/otp/prices.js — GET /api/otp/prices?country=&service=&provider=<ID>
//
// Hidden Provider System:
//   - ?provider= menerima ID internal (angka), BUKAN provider_code.
//   - Response TIDAK return provider_code, provider_name, markup_percent.
//   - Hanya return { prices, server_name } dengan selling_price_cents final.
//
// Harga jual dihitung backend (markup per-provider), bukan dari frontend.
// User tidak pernah tahu provider_cost_cents maupun markup_percent.
import { withHandler } from "../../../src/middleware.js";
import { getAdapter, getDefaultAdapter } from "../../../src/providers/registry.js";
import { computeSellPrice } from "../../../src/otp.js";
import { getDisplayName, sanitizeForUser } from "../../../src/public-view.js";
import { first } from "../../../src/db.js";
import { json } from "../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, csrf: false },
  async (ctx, sess) => {
    const url = new URL(ctx.request.url);
    const country = url.searchParams.get("country");
    const service = url.searchParams.get("service");
    const providerParam = url.searchParams.get("provider");
    const providerId = providerParam ? Number(providerParam) : null;

    let adapter;
    try {
      adapter = providerId
        ? await getAdapter(ctx.env, providerId)
        : await getDefaultAdapter(ctx.env);
    } catch (e) {
      return json({ error: sanitizeForUser(e.message) || "Server tidak tersedia" }, 503);
    }

    let prices;
    try {
      prices = await adapter.getPrices(country, service);
    } catch (e) {
      return json({ error: sanitizeForUser(e.message) || "Gagal memuat harga" }, 502);
    }

    // Ambil markup per-provider dari DB (internal, tidak di-expose ke user)
    const cfg = await first(ctx.env.DB, `SELECT markup_percent FROM providers WHERE id = ?`, [adapter.config.id]);
    const markup = cfg?.markup_percent ?? 15;

    // Return HANYA selling_price_cents (final price). Tidak ada provider_code, provider_cost_cents.
    const enriched = (Array.isArray(prices) ? prices : []).map((p) => {
      const costCents = Number(p.price ?? p.price_cents ?? p.cost ?? p.amount ?? 0);
      const { price, price_cents, cost, amount, ...rest } = p;
      return {
        ...rest,
        selling_price_cents: computeSellPrice(costCents, markup),
      };
    });

    const serverName = await getDisplayName(ctx.env.DB, adapter.config.id);
    return json({ prices: enriched, server_name: serverName });
  },
);
