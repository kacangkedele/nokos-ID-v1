// functions/api/admin/providers/[id]/test.js
//   POST /api/admin/providers/:id/test — test koneksi provider (panggil getCountries)
import { withHandler } from "../../../../../src/middleware.js";
import { testConnection } from "../../../../../src/provider-manager.js";
import { json } from "../../../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", auth: true, admin: true, csrf: true,
    rateBucket: "admin_action", rateIdFrom: (ctx) => ctx.sess?.user?.id || "anon" },
  async (ctx, sess) => {
    try {
      const result = await testConnection(ctx.env, ctx.params.id, sess.user.id);
      return json({ result });
    } catch (e) {
      return json({ error: e.message, code: e.code }, e.code === "PROVIDER_NOT_FOUND" ? 404 : 502);
    }
  },
);
