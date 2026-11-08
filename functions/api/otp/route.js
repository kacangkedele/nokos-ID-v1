// functions/api/otp/route.js — GET /api/otp/route?country=&service=&mode=cheapest&provider=<ID>
//
// Smart provider routing. Return provider yang terpilih + harga jual final.
// Mode: manual (wajib ?provider=<ID>), cheapest, priority (default), availability.
//
// Hidden Provider System:
//   - Response HANYA return { ok, provider_id, server_name, selling_price_cents, mode }.
//   - TIDAK return provider_code, provider_name, provider_config, provider_cost_cents, markup_percent.
//   - ?provider= menerima ID internal (angka), BUKAN provider_code.
//   - Error message di-sanitize sebelum dikirim ke user.
import { withHandler } from "../../../src/middleware.js";
import { resolveProvider } from "../../../src/routing.js";
import { getDisplayName, sanitizeForUser } from "../../../src/public-view.js";
import { json } from "../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, csrf: false },
  async (ctx, sess) => {
    const url = new URL(ctx.request.url);
    const providerParam = url.searchParams.get("provider");
    const opts = {
      country: url.searchParams.get("country"),
      service: url.searchParams.get("service"),
      operator: url.searchParams.get("operator"),
      mode: url.searchParams.get("mode") || "priority",
      // Untuk mode=manual, ?provider= sekarang ID internal; routing.js map ID → config.
      provider_id: providerParam ? Number(providerParam) : null,
    };
    try {
      const result = await resolveProvider(ctx.env, opts);
      const serverName = await getDisplayName(ctx.env.DB, result.providerId);
      return json({
        ok: true,
        provider_id: result.providerId,
        server_name: serverName,
        selling_price_cents: result.sellPrice,
        mode: opts.mode,
      });
    } catch (e) {
      const code = e.code;
      const status = ["NO_ACTIVE_PROVIDER", "NO_PRICE_AVAILABLE", "NO_AVAILABILITY"].includes(code) ? 404 : 422;
      return json({ error: sanitizeForUser(e.message) || "Tidak tersedia" }, status);
    }
  },
);
