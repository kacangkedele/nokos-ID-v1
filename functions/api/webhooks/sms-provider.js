// functions/api/webhooks/sms-provider.js
// Webhook SMS masuk dari RuangOTP. Verifikasi signature HMAC, idempotent.
//
// Signature diharapkan di header: X-RuangOTP-Signature: hex(HMAC-SHA256(secret, body))
// Body: JSON { provider_order_id, sms, status }
import { first, batch, run } from "../../../src/db.js";
import { hmacSHA256, safeEqualHex } from "../../../src/security.js";
import { now } from "../../../src/utils.js";
import { refundOrder } from "../../../src/otp.js";

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  const db = env.DB;
  const sig = request.headers.get("X-RuangOTP-Signature") || "";
  const raw = await request.text();

  // verifikasi signature (bila secret dikonfigurasi)
  if (env.RUANGOTP_WEBHOOK_SECRET) {
    const expected = await hmacSHA256(env.RUANGOTP_WEBHOOK_SECRET, raw);
    if (!safeEqualHex(sig, expected)) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }

  let payload;
  try { payload = JSON.parse(raw); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!payload.provider_order_id) {
    return new Response(JSON.stringify({ error: "provider_order_id wajib" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // cari order berdasarkan provider_order_id (idempotent: cek status)
  const order = await first(db, `SELECT id, user_id, status FROM otp_orders WHERE provider_order_id = ?`, [payload.provider_order_id]);
  if (!order) {
    return new Response(JSON.stringify({ ok: true, ignored: true, reason: "order not found" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (order.status === "completed") {
    return new Response(JSON.stringify({ ok: true, ignored: true, reason: "already completed" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (payload.sms && payload.status !== "cancelled") {
    const t = now();
    await batch(db, [
      {
        sql: `UPDATE otp_orders SET sms_text = ?, sms_received_at = ?, status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status != 'completed'`,
        params: [String(payload.sms).slice(0, 2000), t, t, t, order.id],
      },
      {
        sql: `INSERT INTO notifications (user_id, type, title, body, is_read, reference_id, created_at)
              VALUES (?, 'otp_received', 'OTP Diterima', ?, 0, ?, ?)`,
        params: [order.user_id, `OTP untuk order ${order.id}: ${String(payload.sms).slice(0, 60)}`, order.id, t],
      },
    ]);
  } else if (payload.status === "cancelled" || payload.status === "failed") {
    await refundOrder(db, order, `Webhook provider: ${payload.status}`);
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}
