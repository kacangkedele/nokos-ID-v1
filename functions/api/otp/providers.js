// functions/api/otp/providers.js — GET /api/otp/providers
// Daftar provider aktif untuk pilihan user di katalog.
//
// Hidden Provider System: hanya return { id, display_name }.
// TIDAK return provider_code, provider_name, base_url, api_key, dll.
import { withHandler } from "../../../src/middleware.js";
import { listActiveProviders } from "../../../src/providers/registry.js";
import { maskProviderList } from "../../../src/public-view.js";
import { json } from "../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, csrf: false },
  async (ctx, sess) => {
    const providers = await listActiveProviders(ctx.env.DB);
    return json({ providers: maskProviderList(providers) });
  },
);
