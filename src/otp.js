// src/otp.js — logika pembelian nomor via Multi-Provider + refund handling
//
// MULTI-PROVIDER (master prompt BAGIAN 17):
//   - Setiap order mencatat provider_id + provider_order_id.
//   - Adapter di-load dari registry berdasarkan provider_id.
//   - Smart routing (manual/cheapest/priority/availability) di src/routing.js.
//   - Satu saldo internal Nokos.ID (Unified Wallet) untuk semua provider.
//
// Alur (dari master prompt):
//   1. User pilih country + service (+ provider bila mode=manual)
//   2. Backend resolve provider via routing → hitung harga jual (markup per-provider)
//   3. Tampilkan harga final ke user
//   4. User konfirmasi → CREATE otp_orders(status='pending', provider_id, idempotency_key)
//   5. Cek saldo cukup (balance >= cost)
//   6. Lock saldo: postTransaction(-cost, idempotency_key='order:'+orderId)
//      (saldo sudah dipotong atomik)
//   7. Panggil adapter.purchaseNumber(country, service, operator)
//   8a. Berhasil (dapat nomor) → UPDATE order SET phone_number, provider_order_id,
//       status='active'. Saldo tetap terpotong (sudah di langkah 6).
//   8b. Gagal (NO_NUMBERS / NO_BALANCE / error) → refund:
//       postTransaction(+cost, idempotency_key='refund:'+orderId, ref_type='refund')
//       UPDATE order SET status='failed', refund_ledger_id, failure_reason.
//       Catatan: refund idempotent — idempotency_key unik.
//   9. Timeout dengan status provider belum diketahui → JANGAN retry otomatis.
//      Tandai order status='pending' + flag needs_status_check, admin/provider
//      poll manual via /api/otp/orders/:id/status.
//  10. JANGAN otomatis pindah ke provider lain setelah nomor berhasil diterbitkan.
//
// Anti double-spend: idempotency_key dari klien + UNIQUE constraint.
// Anti double-refund: refund_ledger_id di-set sekali, idempotency_key refund unik.
// Anti double-purchase: provider_order_id di-set sekali (CHECK status='pending').

import { first, run, batch } from "./db.js";
import { ulid, now } from "./utils.js";
import { postTransaction } from "./wallet-ledger.js";
import { getAdapter, getProviderConfig } from "./providers/registry.js";
import { resolveProvider } from "./routing.js";

const DEFAULT_EXPIRY = 900; // 15 menit
const DEFAULT_MARKUP_PERCENT = 15;

/**
 * Hitung harga jual dari harga provider + markup.
 * @param {number} providerCostCents
 * @param {number} markupPercent
 */
export function computeSellPrice(providerCostCents, markupPercent) {
  const markup = Math.ceil((providerCostCents * markupPercent) / 100);
  return providerCostCents + markup;
}

/**
 * Buat order baru (status pending). Belum potong saldo, belum panggil provider.
 * Frontend tampilkan harga dulu; baru panggil /api/otp/orders/:id/confirm.
 *
 * Hidden Provider System + Price Integrity:
 *   - provider_id adalah ID internal (angka), BUKAN provider_code.
 *   - provider_cost_cents TIDAK dipercaya dari frontend. Bila tidak diberikan,
 *     backend resolve sendiri via routing (single source of truth).
 *   - markup diambil dari konfigurasi provider di DB (bukan dari frontend).
 *
 * Multi-provider: provider_id wajib bila mode=manual. Bila null, akan di-resolve
 * di confirmOrder berdasarkan routing mode.
 */
export async function createOrder(db, userId, {
  country_id, service_id, operator_id,
  provider_id, provider_cost_cents, routing_mode,
}, settings, env) {
  const id = ulid();
  const idempotencyKey = `order-create:${ulid()}`;
  const t = now();
  const expirySec = Number(settings?.order_expiry_seconds || DEFAULT_EXPIRY);

  // Bila provider_id diberikan, ambil markup per-provider untuk harga jual akurat.
  let markup = Number(settings?.price_markup_percent || DEFAULT_MARKUP_PERCENT);
  let resolvedProviderCost = provider_cost_cents;

  // Price integrity: bila provider_cost_cents tidak diberikan (atau 0),
  // backend resolve sendiri via adapter.getPrices(). Tidak percaya frontend.
  if ((!resolvedProviderCost || resolvedProviderCost <= 0) && provider_id) {
    try {
      const cfg = await getProviderConfig(db, provider_id);
      markup = cfg.markup_percent ?? markup;
      if (env) {
        const adapter = await getAdapter(env, provider_id, { force: true });
        const prices = await adapter.getPrices(country_id, service_id);
        if (Array.isArray(prices) && prices.length > 0) {
          const match = prices.find((p) => String(p.id || p.code || p.service_code) === String(service_id)) || prices[0];
          const p = match.price ?? match.price_cents ?? match.cost ?? match.amount;
          if (p && Number(p) > 0) resolvedProviderCost = Number(p);
        }
      }
    } catch (e) {
      // bila resolve gagal, biarkan cost_cents dihitung dari 0 (akan ditolak di confirmOrder bila 0)
      console.error("createOrder price resolve failed:", e.message);
    }
  } else if (provider_id) {
    const cfg = await getProviderConfig(db, provider_id);
    markup = cfg.markup_percent ?? markup;
  }

  const sellPrice = computeSellPrice(resolvedProviderCost || 0, markup);

  await run(
    db,
    `INSERT INTO otp_orders
       (id, user_id, idempotency_key, country_id, service_id, operator_id,
        provider_id, cost_cents, provider_cost_cents, status, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [id, userId, idempotencyKey, country_id || null, service_id || null, operator_id || null,
     provider_id || null, sellPrice, resolvedProviderCost || null, t + expirySec, t, t],
  );
  return { id, provider_id, cost_cents: sellPrice, expires_at: t + expirySec };
}

/**
 * Konfirmasi & eksekusi pembelian: potong saldo + panggil provider adapter.
 * Atomic antara potong saldo + update order. Provider call dilakukan setelah
 * potongan saldo berhasil. Bila provider gagal → refund atomik.
 *
 * Multi-provider: adapter di-load via registry berdasarkan order.provider_id.
 * Bila provider_id NULL di order (legacy), fallback ke default active provider.
 *
 * @param {string} orderId
 * @param {object} [opts] - { routingMode } bila perlu resolve provider
 * @returns {Promise<{status, phone_number, provider_order_id, failure_reason?}>}
 */
export async function confirmOrder(db, env, orderId, userId) {
  const order = await first(
    db,
    `SELECT id, user_id, idempotency_key, country_id, service_id, operator_id,
            provider_id, cost_cents, provider_cost_cents, status, expires_at
       FROM otp_orders WHERE id = ?`,
    [orderId],
  );
  if (!order) throw Object.assign(new Error("Order tidak ditemukan"), { code: "NOT_FOUND" });
  if (order.user_id !== userId) throw Object.assign(new Error("Akses ditolak"), { code: "FORBIDDEN" });
  if (order.status !== "pending") {
    return { already_processed: true, status: order.status };
  }
  if (order.expires_at <= now()) {
    await run(db, `UPDATE otp_orders SET status='expired', updated_at=? WHERE id=?`, [now(), order.id]);
    throw Object.assign(new Error("Order kedaluwarsa"), { code: "EXPIRED" });
  }

  // 1. Potong saldo atomik (idempotent via idempotency_key)
  try {
    await postTransaction(db, {
      userId,
      referenceId: order.id,
      transactionType: "order",
      amount: -order.cost_cents, // negatif = debit
      idempotencyKey: `order:${order.id}`,
      description: `Pembelian nomor OTP ${order.id}${order.provider_id ? ` (provider_id=${order.provider_id})` : ""}`,
    });
  } catch (e) {
    if (e.code === "INSUFFICIENT_BALANCE") {
      await run(db, `UPDATE otp_orders SET status='failed', failure_reason='Saldo tidak cukup', updated_at=? WHERE id=?`, [now(), order.id]);
    }
    throw e;
  }

  // 2. Resolve adapter (multi-provider)
  let adapter;
  try {
    if (order.provider_id) {
      adapter = await getAdapter(env, order.provider_id);
    } else {
      // fallback: default active provider (legacy order tanpa provider_id)
      const { getDefaultAdapter } = await import("./providers/registry.js");
      adapter = await getDefaultAdapter(env);
      // backfill provider_id ke order
      await run(db, `UPDATE otp_orders SET provider_id = ?, updated_at = ? WHERE id = ?`,
        [adapter.config.id, now(), order.id]);
    }
  } catch (e) {
    // provider tidak bisa diakses → refund + failed
    await refundOrder(db, order, `Provider tidak tersedia: ${e.message}`);
    return { status: "failed", failure_reason: e.message };
  }

  // 3. Panggil adapter.purchaseNumber
  try {
    const result = await adapter.purchaseNumber(
      {
        country: order.country_id,
        service: order.service_id,
        operator: order.operator_id,
      },
      order.id,
    );

    // 4. Update order: nomor + provider_order_id + status active (atomic)
    const t = now();
    await batch(db, [
      {
        sql: `UPDATE otp_orders
                SET phone_number = ?, provider_order_id = ?, status = 'active',
                    updated_at = ?
              WHERE id = ? AND status = 'pending'`,
        params: [result.phone_number, result.provider_order_id, t, order.id],
      },
      {
        sql: `INSERT INTO wallet_audit_logs (user_id, action, reference_id, details, created_at)
              VALUES (?, 'otp_order_placed', ?, ?, ?)`,
        params: [userId, order.id, JSON.stringify({
          // Internal audit: provider_code TIDAK di-expose ke user (hanya di audit log).
          provider_code: adapter.code,
          provider_order_id: result.provider_order_id,
          cost: order.cost_cents,
        }), t],
      },
    ]);

    // Hidden Provider System: return ke user TIDAK boleh berisi provider_code / provider_order_id.
    // provider_order_id dicatat internal (untuk tracking & polling adapter),
    // tapi tidak di-return ke response API publik.
    return {
      status: "active",
      phone_number: result.phone_number,
      cost_cents: order.cost_cents,
    };
  } catch (e) {
    // Provider unreachable / timeout. JANGAN buat order kedua.
    // Tandai order perlu status check manual.
    if (e.code === "PROVIDER_TIMEOUT" || e.code === "PROVIDER_UNREACHABLE") {
      const t = now();
      // failure_reason internal (audit). User-facing via sanitizeForUser.
      await run(
        db,
        `UPDATE otp_orders SET status='pending', failure_reason=?, updated_at=? WHERE id=?`,
        [`Server timeout, perlu cek status manual (${adapter?.code || "unknown"})`, t, order.id],
      );
      // saldo sudah dipotong — refund terjadi saat admin/providers konfirmasi gagal
      // via /api/otp/orders/:id/status. Jangan refund otomatis (sesuai master prompt).
      return { status: "pending_timeout", failure_reason: "Sedang menunggu konfirmasi server. Saldo ditahan sementara." };
    }
    // error lain (PURCHASE_FAILED, NO_NUMBERS, dll) → refund + failed
    await refundOrder(db, order, e.message || e.code);
    // User-facing failure_reason: generic. Detail internal ada di audit_log.
    return { status: "failed", failure_reason: "Pembelian gagal. Saldo telah dikembalikan." };
  }
}

/**
 * Refund order (idempotent). Dipakai bila provider gagal / order gagal.
 */
export async function refundOrder(db, order, reason) {
  // cek apakah sudah pernah refund
  const existing = await first(db, `SELECT refund_ledger_id FROM otp_orders WHERE id = ?`, [order.id]);
  if (existing?.refund_ledger_id) {
    return { already_refunded: true };
  }
  // cek apakah order pernah dipotong (ledger order ada)
  const orderTx = await first(
    db,
    `SELECT id FROM wallet_transactions WHERE idempotency_key = ? AND user_id = ? AND transaction_type='order'`,
    [`order:${order.id}`, order.user_id],
  );
  if (!orderTx) {
    // tidak pernah dipotong → tidak ada yang direfund, hanya update status
    await run(db, `UPDATE otp_orders SET status='failed', failure_reason=?, updated_at=? WHERE id=?`, [reason.slice(0, 500), now(), order.id]);
    return { skipped: true, reason: "no prior debit" };
  }

  const tx = await postTransaction(db, {
    userId: order.user_id,
    referenceId: order.id,
    transactionType: "refund",
    amount: order.cost_cents, // positif = kredit balik
    idempotencyKey: `refund:${order.id}`,
    description: `Refund order OTP ${order.id}: ${reason.slice(0, 100)}`,
  });

  const t = now();
  await batch(db, [
    {
      sql: `UPDATE otp_orders SET status='failed', failure_reason=?, refund_ledger_id=?, updated_at=? WHERE id=? AND refund_ledger_id IS NULL`,
      params: [reason.slice(0, 500), tx.ledger_id, t, order.id],
    },
    {
      sql: `INSERT INTO wallet_audit_logs (user_id, action, reference_id, details, created_at)
            VALUES (?, 'otp_refund', ?, ?, ?)`,
      params: [order.user_id, order.id, JSON.stringify({ amount: order.cost_cents, reason, ledger_id: tx.ledger_id }), t],
    },
    {
      sql: `INSERT INTO notifications (user_id, type, title, body, is_read, reference_id, created_at)
            VALUES (?, 'order_failed', 'Pembelian Gagal - Saldo Direfund', ?, 0, ?, ?)`,
      // Hidden Provider System: body notifikasi TIDAK boleh mengandung nama provider asli.
      // Gunakan teks generic "Server" — detail internal ada di audit_log.
      params: [order.user_id, `Pesanan ${order.id} gagal diproses. Saldo Rp${order.cost_cents / 100} telah dikembalikan.`, order.id, t],
    },
  ]);

  return { refunded: true, ledger_id: tx.ledger_id, amount: order.cost_cents };
}

/**
 * Poll status order dari provider adapter. Update SMS bila masuk.
 */
export async function pollOrderStatus(db, env, orderId, userId) {
  const order = await first(
    db,
    `SELECT id, user_id, provider_id, provider_order_id, status, expires_at FROM otp_orders WHERE id = ?`,
    [orderId],
  );
  if (!order) throw Object.assign(new Error("Order tidak ditemukan"), { code: "NOT_FOUND" });
  if (order.user_id !== userId) throw Object.assign(new Error("Akses ditolak"), { code: "FORBIDDEN" });
  if (!order.provider_order_id) {
    return { status: order.status, message: "Belum ada provider_order_id" };
  }
  if (order.status === "completed" || order.status === "expired") {
    return { status: order.status, sms_text: null };
  }

  // resolve adapter (force=true agar bisa poll bila provider degraded)
  let adapter;
  try {
    adapter = await getAdapter(env, order.provider_id, { force: true });
  } catch (e) {
    return { status: order.status, message: `Provider tidak bisa diakses: ${e.message}` };
  }

  const result = await adapter.getOrderStatus(order.provider_order_id, order.id);

  if (result.sms) {
    const t = now();
    await batch(db, [
      {
        sql: `UPDATE otp_orders SET sms_text=?, sms_received_at=?, status='completed', completed_at=?, updated_at=? WHERE id=?`,
        params: [result.sms, t, t, t, order.id],
      },
      {
        sql: `INSERT INTO notifications (user_id, type, title, body, is_read, reference_id, created_at)
              VALUES (?, 'otp_received', 'OTP Diterima', ?, 0, ?, ?)`,
        params: [userId, `OTP untuk order ${order.id}: ${result.sms.slice(0, 60)}`, order.id, t],
      },
    ]);
    return { status: "completed", sms_text: result.sms };
  }
  if (result.status === "cancelled") {
    await run(db, `UPDATE otp_orders SET status='cancelled', cancelled_at=?, updated_at=? WHERE id=?`, [now(), now(), order.id]);
    return { status: "cancelled" };
  }
  return { status: order.status, message: "Menunggu OTP" };
}

/**
 * Cancel order (bila status pending/active, belum completed).
 * Multi-provider: panggil adapter.cancelOrder bila ada provider_order_id.
 */
export async function cancelOrder(db, env, orderId, userId) {
  const order = await first(db, `SELECT id, user_id, provider_id, provider_order_id, status, cost_cents FROM otp_orders WHERE id = ?`, [orderId]);
  if (!order) throw Object.assign(new Error("Order tidak ditemukan"), { code: "NOT_FOUND" });
  if (order.user_id !== userId) throw Object.assign(new Error("Akses ditolak"), { code: "FORBIDDEN" });
  if (order.status === "completed") throw Object.assign(new Error("Order sudah selesai, tidak bisa dibatalkan"), { code: "INVALID_STATE" });
  if (order.status === "cancelled" || order.status === "failed") {
    return { already_cancelled: true };
  }

  // Panggil adapter.cancelOrder bila ada provider_order_id
  if (order.provider_order_id && order.provider_id) {
    try {
      const adapter = await getAdapter(env, order.provider_id, { force: true });
      await adapter.cancelOrder(order.provider_order_id, order.id);
    } catch (e) {
      // log tapi lanjut; refund tetap proses
      console.error("cancel provider error:", e.message);
    }
  }

  // Refund bila pernah dipotong
  await refundOrder(db, order, "Dibatalkan oleh pengguna");
  await run(db, `UPDATE otp_orders SET status='cancelled', cancelled_at=?, updated_at=? WHERE id=?`, [now(), now(), order.id]);
  return { status: "cancelled", refunded: true };
}

/** List order user (paginate). Hidden Provider System: return server_name (display_name),
 *  BUKAN provider_code / provider_name. provider_id tetap di-return untuk polling adapter
 *  (internal, tidak mengekspose identitas asli). */
export async function listUserOrders(db, userId, { limit = 20, offset = 0 } = {}) {
  const res = await db
    .prepare(`SELECT o.id, o.country_id, o.service_id, o.phone_number, o.cost_cents, o.status, o.sms_text,
                     o.created_at, o.expires_at, o.completed_at,
                     COALESCE(p.display_name, 'Nokos.ID Server') AS server_name
                FROM otp_orders o
                LEFT JOIN providers p ON p.id = o.provider_id
               WHERE o.user_id = ?
               ORDER BY o.created_at DESC LIMIT ? OFFSET ?`)
    .bind(userId, Math.min(limit, 50), offset)
    .all();
  return res.results || [];
}

// ---- Parser respons provider pindah ke masing-masing adapter class ----
// (RuangOTPAdapter / KirimKodeAdapter di src/providers/)
