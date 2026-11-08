// functions/api/otp/orders/[id]/index.js
//   GET   /api/otp/orders/:id      — detail order
//   POST  /api/otp/orders/:id      — konfirmasi & eksekusi pembelian
//   PATCH /api/otp/orders/:id      — poll OTP status
//
// Hidden Provider System:
//   - GET hanya return server_name (display_name), BUKAN provider_code/name/id.
//   - failure_reason TIDAK di-return ke user (internal only).
//   - POST/PATCH response dari confirmOrder/pollOrderStatus sudah di-sanitize.
import { withHandler } from "../../../../../src/middleware.js";
import { first } from "../../../../../src/db.js";
import { confirmOrder, pollOrderStatus } from "../../../../../src/otp.js";
import { json } from "../../../../../src/utils.js";

export const onRequestGet = withHandler(
  { method: "GET", auth: true, csrf: false },
  async (ctx, sess) => {
    const order = await first(ctx.env.DB,
      `SELECT o.id, o.user_id, o.country_id, o.service_id, o.phone_number, o.cost_cents,
              o.status, o.sms_text, o.created_at, o.expires_at, o.completed_at,
              COALESCE(p.display_name, 'Nokos.ID Server') AS server_name
         FROM otp_orders o
         LEFT JOIN providers p ON p.id = o.provider_id
        WHERE o.id = ?`, [ctx.params.id]);
    if (!order) return json({ error: "Pesanan tidak ditemukan" }, 404);
    if (order.user_id !== sess.user.id) return json({ error: "Akses ditolak" }, 403);
    // Jangan expose failure_reason (bisa mengandung nama provider asli).
    return json({ order });
  },
);

export const onRequestPost = withHandler(
  { method: "POST", auth: true, csrf: true, rateBucket: "otp_user",
    rateIdFrom: (ctx) => ctx.sess?.user?.id || "anon" },
  async (ctx, sess) => {
    const result = await confirmOrder(ctx.env.DB, ctx.env, ctx.params.id, sess.user.id);
    return json({ ok: true, result });
  },
);

// Polling status OTP
export const onRequestPatch = withHandler(
  { method: "PATCH", auth: true, csrf: true },
  async (ctx, sess) => {
    const result = await pollOrderStatus(ctx.env.DB, ctx.env, ctx.params.id, sess.user.id);
    return json({ ok: true, result });
  },
);
