// functions/api/otp/orders/[id]/status.js — GET /api/otp/orders/:id/status (poll provider)
import { withHandler } from "../../../../../src/middleware.js";
import { pollOrderStatus } from "../../../../../src/otp.js";
import { json } from "../../../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, csrf: false, rateBucket: "otp_user",
    rateIdFrom: (ctx) => ctx.sess?.user?.id || "anon" },
  async (ctx, sess) => {
    const result = await pollOrderStatus(ctx.env.DB, ctx.env, ctx.params.id, sess.user.id);
    return json({ ok: true, result });
  },
);
