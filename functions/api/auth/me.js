// functions/api/auth/me.js
import { withHandler } from "../../../src/middleware.js";
import { getWalletSummary } from "../../../src/wallet-ledger.js";
import { json } from "../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true },
  async (ctx, sess) => {
    const wallet = await getWalletSummary(ctx.env.DB, sess.user.id);
    return json({ user: sess.user, wallet });
  },
);
