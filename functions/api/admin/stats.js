// functions/api/admin/stats.js — dashboard statistik admin
import { withHandler } from "../../../src/middleware.js";
import { first, all } from "../../../src/db.js";
import { json } from "../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, admin: true, csrf: false },
  async (ctx, sess) => {
    const db = ctx.env.DB;
    const stats = await first(
      db,
      `SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM users WHERE status='active') AS active_users,
        (SELECT COUNT(*) FROM deposits WHERE status='pending') AS deposits_pending,
        (SELECT COUNT(*) FROM deposits WHERE status='approved') AS deposits_approved,
        (SELECT COUNT(*) FROM deposits WHERE status='rejected') AS deposits_rejected,
        (SELECT COALESCE(SUM(amount),0) FROM deposits WHERE status='approved') AS total_deposit_amount,
        (SELECT COUNT(*) FROM otp_orders WHERE status='active') AS orders_active,
        (SELECT COUNT(*) FROM otp_orders WHERE status='completed') AS orders_completed,
        (SELECT COUNT(*) FROM otp_orders WHERE status='failed') AS orders_failed,
        (SELECT COALESCE(SUM(cost_cents),0) FROM otp_orders WHERE status IN ('active','completed')) AS total_order_amount`,
    );
    const providerErr = await first(db, `SELECT COUNT(*) AS n FROM provider_responses WHERE http_status >= 400`);
    return json({
      stats: {
        ...stats,
        provider_errors_24h: providerErr?.n || 0,
      },
    });
  },
);
