// functions/api/otp/services.js — GET /api/otp/services?country=ID&provider=<ID>
//
// Hidden Provider System: response HANYA return { services, server_name }.
import { withHandler } from "../../../src/middleware.js";
import { getAdapter, getDefaultAdapter } from "../../../src/providers/registry.js";
import { getDisplayName, sanitizeForUser } from "../../../src/public-view.js";
import { json } from "../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, csrf: false },
  async (ctx, sess) => {
    const url = new URL(ctx.request.url);
    const country = url.searchParams.get("country");
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
    let services;
    try {
      services = await adapter.getServices(country);
    } catch (e) {
      return json({ error: sanitizeForUser(e.message) || "Gagal memuat layanan" }, 502);
    }
    const serverName = await getDisplayName(ctx.env.DB, adapter.config.id);
    return json({ services, server_name: serverName });
  },
);
