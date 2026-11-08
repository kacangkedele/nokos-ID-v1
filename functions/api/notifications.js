// functions/api/notifications.js — GET /api/notifications + POST /api/notifications/:id/read
import { withHandler, logAudit } from "../../src/middleware.js";
import { all, first, run } from "../../src/db.js";
import { json, now } from "../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, csrf: false },
  async (ctx, sess) => {
    const rows = await all(ctx.env.DB,
      `SELECT id, type, title, body, is_read, reference_id, created_at
         FROM notifications WHERE user_id = ?
         ORDER BY created_at DESC LIMIT 50`, [sess.user.id]);
    const unread = await first(ctx.env.DB, `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0`, [sess.user.id]);
    return json({ notifications: rows, unread: unread?.n || 0 });
  },
);

export const onRequestPost = withHandler(
  { method: "POST", auth: true, csrf: true },
  async (ctx, sess) => {
    const url = new URL(ctx.request.url);
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id wajib" }, 422);
    await run(ctx.env.DB, `UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, [id, sess.user.id]);
    return json({ ok: true });
  },
);
