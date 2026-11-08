// functions/api/deposits/[id]/cancel.js
import { withHandler } from "../../../../src/middleware.js";
import { cancelDeposit } from "../../../../src/deposit.js";
import { json } from "../../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", auth: true, csrf: true },
  async (ctx, sess) => {
    const result = await cancelDeposit(ctx.env.DB, ctx.params.id, sess.user.id);
    return json({ ok: true, result });
  },
);
