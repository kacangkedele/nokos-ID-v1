// functions/api/admin/deposits/index.js
//   GET /api/admin/deposits — daftar antrian verifikasi (filter status)
import { withHandler } from "../../../../src/middleware.js";
import { listPendingDeposits } from "../../../../src/deposit.js";
import { all } from "../../../../src/db.js";
import { json } from "../../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, admin: true, csrf: false },
  async (ctx, sess) => {
    const url = new URL(ctx.request.url);
    const status = url.searchParams.get("status") || "pending";
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);

    if (status === "pending") {
      const rows = await listPendingDeposits(ctx.env.DB, { limit, offset });
      return json({ deposits: rows, status: "pending" });
    }
    // filter status lain
    const rows = await all(
      ctx.env.DB,
      `SELECT d.id, d.user_id, u.username, u.email, d.deposit_code, d.amount,
              d.payment_proof_key, d.payment_proof_mime, d.status, d.rejection_reason,
              d.admin_id, d.verified_at, d.created_at
         FROM deposits d JOIN users u ON u.id = d.user_id
        WHERE d.status = ?
        ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
      [status, Math.min(limit, 100), offset],
    );
    return json({ deposits: rows, status });
  },
);
