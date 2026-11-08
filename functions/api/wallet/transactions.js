// functions/api/wallet/transactions.js — GET /api/wallet/transactions
import { withHandler } from "../../../src/middleware.js";
import { all } from "../../../src/db.js";
import { json } from "../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true },
  async (ctx, sess) => {
    const url = new URL(ctx.request.url);
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const rows = await all(
      ctx.env.DB,
      `SELECT id, reference_id, transaction_type, amount, balance_before, balance_after,
              status, description, created_at
         FROM wallet_transactions WHERE user_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [sess.user.id, Math.min(limit, 100), offset],
    );
    return json({ transactions: rows });
  },
);
