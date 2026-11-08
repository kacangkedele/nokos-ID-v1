// functions/api/admin/deposits/[id]/approve.js
import { withHandler } from "../../../../../src/middleware.js";
import { approveDeposit } from "../../../../../src/deposit.js";
import { json } from "../../../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", auth: true, admin: true, roles: ["super_admin", "admin_deposit"],
    csrf: true, rateBucket: "admin_action", rateIdFrom: (ctx) => ctx.sess?.user?.id || "anon" },
  async (ctx, sess) => {
    const result = await approveDeposit(ctx.env.DB, ctx.env, ctx.params.id, sess.user);
    return json({ ok: true, result });
  },
);
