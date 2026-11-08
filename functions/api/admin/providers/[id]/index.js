// functions/api/admin/providers/[id]/index.js
//   GET    /api/admin/providers/:id — detail provider
//   PATCH  /api/admin/providers/:id — update (super_admin only)
//   DELETE /api/admin/providers/:id — hapus (super_admin only, wajib disabled dulu)
import { withHandler } from "../../../../../src/middleware.js";
import { getProvider, updateProvider, deleteProvider } from "../../../../../src/provider-manager.js";
import { json } from "../../../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, admin: true, csrf: false },
  async (ctx, sess) => {
    const p = await getProvider(ctx.env.DB, ctx.params.id);
    if (!p) return json({ error: "Provider tidak ditemukan" }, 404);
    let configuration = {};
    try { configuration = JSON.parse(p.configuration || "{}"); } catch {}
    // Jangan expose api_key value (memang tidak disimpan, hanya nama secret)
    return json({ provider: { ...p, configuration, api_key_value: undefined } });
  },
);

export const onRequestPatch = withHandler(
  { method: "PATCH", auth: true, admin: true, roles: ["super_admin"], csrf: true },
  async (ctx, sess) => {
    const body = await ctx.request.json().catch(() => null);
    if (!body) return json({ error: "Body tidak valid" }, 400);
    // bila configuration object, serialize
    try {
      const updated = await updateProvider(ctx.env.DB, ctx.params.id, body, sess.user.id);
      return json({ provider: updated });
    } catch (e) {
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "TEST_REQUIRED" || e.code === "INVALID_STATE" ? 409 : 422;
      return json({ error: e.message, code: e.code, field: e.field }, status);
    }
  },
);

export const onRequestDelete = withHandler(
  { method: "DELETE", auth: true, admin: true, roles: ["super_admin"], csrf: true },
  async (ctx, sess) => {
    try {
      await deleteProvider(ctx.env.DB, ctx.params.id, sess.user.id);
      return json({ ok: true, deleted: true });
    } catch (e) {
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "HAS_ORDERS" || e.code === "INVALID_STATE" ? 409 : 400;
      return json({ error: e.message, code: e.code }, status);
    }
  },
);
