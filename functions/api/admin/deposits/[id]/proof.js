// functions/api/admin/deposits/[id]/proof.js
//   GET /api/admin/deposits/:id/proof — stream bukti dari R2 (admin only)
import { withHandler } from "../../../../../src/middleware.js";
import { getDeposit } from "../../../../../src/deposit.js";
import { streamObject } from "../../../../../src/r2.js";
import { json } from "../../../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, admin: true, roles: ["super_admin", "admin_deposit", "admin_support"] },
  async (ctx, sess) => {
    const dep = await getDeposit(ctx.env.DB, ctx.params.id, sess.user.id, true);
    if (!dep) return json({ error: "Deposit tidak ditemukan" }, 404);
    if (!dep.payment_proof_key) return json({ error: "Bukti belum diunggah" }, 404);
    const stream = await streamObject(ctx.env.BUKTI, dep.payment_proof_key);
    if (!stream) return json({ error: "File bukti tidak ditemukan di R2" }, 404);
    return stream;
  },
);
