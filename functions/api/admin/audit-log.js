// functions/api/admin/audit-log.js — daftar audit log (super_admin / admin_ops)
import { withHandler } from "../../../src/middleware.js";
import { all } from "../../../src/db.js";
import { json } from "../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, admin: true, roles: ["super_admin", "admin_ops"] },
  async (ctx, sess) => {
    const url = new URL(ctx.request.url);
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const action = url.searchParams.get("action");
    let sql = `SELECT a.id, a.user_id, a.admin_id, a.action, a.reference_id, a.details,
                      a.ip, a.created_at, u.username AS user_username, adm.username AS admin_username
                 FROM wallet_audit_logs a
                 LEFT JOIN users u ON u.id = a.user_id
                 LEFT JOIN users adm ON adm.id = a.admin_id`;
    const params = [];
    if (action) {
      sql += ` WHERE a.action = ?`;
      params.push(action);
    }
    sql += ` ORDER BY a.created_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.min(limit, 200), offset);
    const rows = await all(ctx.env.DB, sql, params);
    return json({ logs: rows });
  },
);
