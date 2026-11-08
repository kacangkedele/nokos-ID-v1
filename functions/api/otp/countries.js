// functions/api/otp/countries.js — GET /api/otp/countries?provider=<ID>
//
// Hidden Provider System: response HANYA return { countries, server_name }.
// TIDAK return provider_code, provider_name, base_url.
//
// Catatan: parameter ?provider= sekarang menerima ID internal (angka),
// BUKAN provider_code. User tidak pernah tahu provider_code asli.
import { withHandler } from "../../../src/middleware.js";
import { getAdapter, getDefaultAdapter } from "../../../src/providers/registry.js";
import { getDisplayName, sanitizeForUser } from "../../../src/public-view.js";
import { json } from "../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, csrf: false },
  async (ctx, sess) => {
    const url = new URL(ctx.request.url);
    const providerParam = url.searchParams.get("provider");
    // ?provider= sekarang ID internal (angka), bukan code
    const providerId = providerParam ? Number(providerParam) : null;
    let adapter;
    try {
      adapter = providerId
        ? await getAdapter(ctx.env, providerId)
        : await getDefaultAdapter(ctx.env);
    } catch (e) {
      return json({ error: sanitizeForUser(e.message) || "Server tidak tersedia" }, 503);
    }
    let countries;
    try {
      countries = await adapter.getCountries();
    } catch (e) {
      return json({ error: sanitizeForUser(e.message) || "Gagal memuat negara" }, 502);
    }
    const serverName = await getDisplayName(ctx.env.DB, adapter.config.id);
    return json({ countries, server_name: serverName });
  },
);
