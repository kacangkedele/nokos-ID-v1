// functions/api/deposits/[id]/index.js
//   GET  /api/deposits/:id       — detail deposit (pemilik / admin)
//   POST /api/deposits/:id/cancel — batal deposit pending
import { withHandler } from "../../../../src/middleware.js";
import { getDeposit, cancelDeposit } from "../../../../src/deposit.js";
import { json } from "../../../../src/utils.js";

const isAdminRole = (r) => ["super_admin", "admin_deposit", "admin_support", "admin_ops"].includes(r);

export const onRequestGet = withHandler(
  { method: "GET", auth: true },
  async (ctx, sess) => {
    const isAdmin = isAdminRole(sess.user.role);
    const dep = await getDeposit(ctx.env.DB, ctx.params.id, sess.user.id, isAdmin);
    if (!dep) return json({ error: "Deposit tidak ditemukan" }, 404);
    // jangan bocorkan payment_proof_key ke user biasa; beri flag punya_bukti
    const proof = dep.payment_proof_key ? { has_proof: true, mime: dep.payment_proof_mime } : { has_proof: false };
    return json({
      deposit: {
        id: dep.id, deposit_code: dep.deposit_code, amount: dep.amount,
        payment_method: dep.payment_method, status: dep.status,
        rejection_reason: dep.rejection_reason, verified_at: dep.verified_at,
        created_at: dep.created_at, updated_at: dep.updated_at, proof,
      },
    });
  },
);
