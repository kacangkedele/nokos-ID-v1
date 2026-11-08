// functions/api/wallet/index.js — GET /api/wallet : ringkasan saldo
import { withHandler } from "../../../src/middleware.js";
import { getWalletSummary } from "../../../src/wallet-ledger.js";
import { json } from "../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true },
  async (ctx, sess) => {
    const wallet = await getWalletSummary(ctx.env.DB, sess.user.id);
    return json({ wallet });
  },
);
