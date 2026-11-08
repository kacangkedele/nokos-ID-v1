// functions/api/otp/orders/[id]/cancel.js — POST /api/otp/orders/:id/cancel
import { withHandler } from "../../../../../src/middleware.js";
import { cancelOrder } from "../../../../../src/otp.js";
import { json } from "../../../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", auth: true, csrf: true, rateBucket: "otp_user",
    rateIdFrom: (ctx) => ctx.sess?.user?.id || "anon" },
  async (ctx, sess) => {
    const result = await cancelOrder(ctx.env.DB, ctx.env, ctx.params.id, sess.user.id);
    return json({ ok: true, result });
  },
);
