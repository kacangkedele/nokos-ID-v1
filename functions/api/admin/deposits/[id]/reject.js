// functions/api/admin/deposits/[id]/reject.js
import { withHandler } from "../../../../../src/middleware.js";
import { rejectDeposit } from "../../../../../src/deposit.js";
import { sanitizeText } from "../../../../../src/validation.js";
import { json } from "../../../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", auth: true, admin: true, roles: ["super_admin", "admin_deposit"],
    csrf: true, rateBucket: "admin_action", rateIdFrom: (ctx) => ctx.sess?.user?.id || "anon" },
  async (ctx, sess) => {
    const body = await ctx.request.json().catch(() => ({}));
    const reason = sanitizeText(body.reason, 500);
    const result = await rejectDeposit(ctx.env.DB, ctx.env, ctx.params.id, sess.user, reason);
    return json({ ok: true, result });
  },
);
