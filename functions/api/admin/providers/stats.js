// functions/api/admin/providers/stats.js
//   GET /api/admin/providers/stats — statistik semua provider
import { withHandler } from "../../../../src/middleware.js";
import { providerStats } from "../../../../src/provider-manager.js";
import { json } from "../../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, admin: true, csrf: false },
  async (ctx, sess) => {
    const stats = await providerStats(ctx.env.DB);
    return json({ stats });
  },
);
