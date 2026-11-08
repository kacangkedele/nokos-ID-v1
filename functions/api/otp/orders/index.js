// functions/api/otp/orders/index.js
//   POST /api/otp/orders        — buat order baru (status pending, belum potong saldo)
//   GET  /api/otp/orders        — daftar order user
//
// Multi-provider + Hidden Provider System:
//   - body.provider_id (ID internal angka) opsional, untuk mode=manual.
//   - Harga TIDAK diterima dari frontend (anti manipulasi).
//     Backend resolve harga via /api/otp/route → selling_price_cents dihitung di backend.
//     confirmOrder memakai cost_cents dari DB (yang dihitung backend di createOrder).
import { withHandler } from "../../../../src/middleware.js";
import { createOrder, listUserOrders } from "../../../../src/otp.js";
import { json } from "../../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", auth: true, csrf: true, rateBucket: "otp_user",
    rateIdFrom: (ctx) => ctx.sess?.user?.id || "anon" },
  async (ctx, sess) => {
    const body = await ctx.request.json().catch(() => null);
    if (!body) return json({ error: "Body tidak valid" }, 400);
    if (!body.country_id || !body.service_id) {
      return json({ error: "country_id dan service_id wajib diisi" }, 422);
    }
    // Hidden Provider System + price integrity:
    //   - provider_id diterima sebagai ID internal (angka), BUKAN provider_code.
    //   - provider_cost_cents TIDAK diterima dari frontend. Backend resolve harga
    //     via routing (lihat createOrder → getProviderConfig → markup per-provider).
    //     Frontend seharusnya sudah panggil /api/otp/route untuk dapat selling_price_cents,
    //     tapi backend tetap yang hitung ulang (single source of truth).
    const order = await createOrder(ctx.env.DB, sess.user.id, {
      country_id: body.country_id,
      service_id: body.service_id,
      operator_id: body.operator_id,
      provider_id: body.provider_id ? Number(body.provider_id) : null,
      routing_mode: body.routing_mode,
    }, ctx.settings, ctx.env);
    return json({ order }, 201);
  },
);

export const onRequestGet = withHandler(
  { method: "GET", auth: true, csrf: false },
  async (ctx, sess) => {
    const url = new URL(ctx.request.url);
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const orders = await listUserOrders(ctx.env.DB, sess.user.id, { limit, offset });
    return json({ orders });
  },
);
