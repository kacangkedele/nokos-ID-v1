// functions/api/deposits/index.js
//   POST /api/deposits       — buat deposit baru (status pending)
//   GET  /api/deposits       — daftar deposit user
import { withHandler } from "../../../src/middleware.js";
import { createDeposit, listUserDeposits } from "../../../src/deposit.js";
import { validateDepositAmount } from "../../../src/validation.js";
import { json } from "../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", auth: true, csrf: true, rateBucket: "deposit_user",
    rateIdFrom: (ctx) => ctx.sess?.user?.id || "anon" },
  async (ctx, sess) => {
    const body = await ctx.request.json().catch(() => null);
    if (!body) return json({ error: "Body tidak valid" }, 400);
    let amount;
    try {
      amount = validateDepositAmount(body.amount, ctx.settings);
    } catch (e) {
      return json({ error: e.message, field: e.field }, 422);
    }
    const dep = await createDeposit(ctx.env.DB, sess.user.id, amount, ctx.settings);
    return json({ deposit: dep }, 201);
  },
);

export const onRequestGet = withHandler(
  { method: "GET", auth: true },
  async (ctx, sess) => {
    const url = new URL(ctx.request.url);
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const rows = await listUserDeposits(ctx.env.DB, sess.user.id, { limit, offset });
    return json({ deposits: rows });
  },
);
