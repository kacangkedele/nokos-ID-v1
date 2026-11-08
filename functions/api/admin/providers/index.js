// functions/api/admin/providers/index.js
//   GET  /api/admin/providers          — daftar semua provider
//   POST /api/admin/providers          — buat provider baru (super_admin only)
import { withHandler } from "../../../../src/middleware.js";
import { listProviders, createProvider } from "../../../../src/provider-manager.js";
import { supportedProviders } from "../../../../src/providers/registry.js";
import { json } from "../../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, admin: true, csrf: false },
  async (ctx, sess) => {
    const providers = await listProviders(ctx.env.DB);
    return json({ providers, supported_codes: supportedProviders() });
  },
);

export const onRequestPost = withHandler(
  { method: "POST", auth: true, admin: true, roles: ["super_admin"], csrf: true },
  async (ctx, sess) => {
    const body = await ctx.request.json().catch(() => null);
    if (!body) return json({ error: "Body tidak valid" }, 400);
    // validasi: provider_code harus adapter yang terdaftar di registry
    const supported = supportedProviders();
    if (!supported.includes(body.provider_code)) {
      return json({
        error: `provider_code '${body.provider_code}' tidak didukung. Tersedia: ${supported.join(", ")}`,
        supported_codes: supported,
      }, 422);
    }
    try {
      const provider = await createProvider(ctx.env.DB, body, sess.user.id);
      return json({ provider }, 201);
    } catch (e) {
      return json({ error: e.message, code: e.code, field: e.field }, e.code === "VALIDATION" ? 422 : 409);
    }
  },
);
