// src/deposit.js — logika deposit QRIS Manual
//
// Alur:
//   createDeposit(amount) → INSERT deposits(status='pending')
//   attachProof(id, file) → upload R2 + UPDATE payment_proof_key
//   approveDeposit(id, admin) → postTransaction(+amount) + UPDATE status='approved'
//   rejectDeposit(id, admin, reason) → UPDATE status='rejected' (saldo TIDAK berubah)
//   cancelDeposit(id, user) → UPDATE status='cancelled' (bila belum di-approve)
//
// Aturan keamanan (dari master prompt):
//   - Upload bukti TIDAK otomatis menambah saldo.
//   - Frontend TIDAK boleh set status='approved'.
//   - Approve hanya untuk admin berwenang + 2FA aktif.
//   - Idempoten: deposit tidak bisa di-approve dua kali.
//   - Bukti tidak boleh dipakai ulang (unique payment_proof_key).

import { first, run, batch } from "./db.js";
import { ulid, depositCode, now } from "./utils.js";
import { postTransaction } from "./wallet-ledger.js";
import { uploadProof } from "./r2.js";

/**
 * Buat deposit baru (status pending). Belum ada perubahan saldo.
 */
export async function createDeposit(db, userId, amount, settings) {
  const id = ulid();
  const code = depositCode();
  const t = now();
  const merchant = settings?.qris_merchant_name || "Angga Official";
  await run(
    db,
    `INSERT INTO deposits (id, user_id, deposit_code, amount, payment_method, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'qris', 'pending', ?, ?)`,
    [id, userId, code, amount, t, t],
  );
  return { id, deposit_code: code, amount, merchant_name: merchant };
}

/**
 * Attach bukti pembayaran (upload ke R2). Status tetap 'pending'.
 * Tidak menambah saldo. Bukti unik per deposit (key baru).
 */
export async function attachProof(db, env, depositId, userId, file, mime) {
  const dep = await first(
    db,
    `SELECT id, user_id, status FROM deposits WHERE id = ?`,
    [depositId],
  );
  if (!dep) throw new Error("Deposit tidak ditemukan");
  if (dep.user_id !== userId) throw new Error("Akses ditolak"); // IDOR guard
  if (dep.status !== "pending") throw new Error("Deposit sudah diproses, tidak bisa upload ulang");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { key, mime: storedMime } = await uploadProof(env.BUKTI, bytes, mime, { userId, depositId });
  await run(
    db,
    `UPDATE deposits SET payment_proof_key = ?, payment_proof_mime = ?, updated_at = ? WHERE id = ?`,
    [key, storedMime, now(), depositId],
  );
  return { key, mime: storedMime };
}

/**
 * APPROVE deposit oleh admin.
 * - Cek admin punya hak (role admin_deposit atau super_admin).
 * - Cek deposit masih 'pending' (idempoten: tidak bisa approve 2x).
 * - postTransaction(+amount, idempotency_key=`dep:${id}`) → atomic ledger + balance.
 * - UPDATE deposits SET status='approved', admin_id, verified_at, ledger_id.
 * - INSERT audit log + notifikasi.
 *
 * Semua dalam satu D1 batch() (atomic). Bila gagal, rollback total.
 */
export async function approveDeposit(db, env, depositId, adminUser) {
  // pre-check admin permission
  if (!canVerifyDeposit(adminUser)) {
    throw Object.assign(new Error("Anda tidak punya hak verifikasi deposit"), { code: "FORBIDDEN" });
  }
  await requireAdmin2FA(db, env, adminUser.id);

  const dep = await first(
    db,
    `SELECT id, user_id, amount, status, payment_proof_key, ledger_id FROM deposits WHERE id = ?`,
    [depositId],
  );
  if (!dep) throw new Error("Deposit tidak ditemukan");
  if (dep.status === "approved") {
    return { already_approved: true, ledger_id: dep.ledger_id };
  }
  if (dep.status !== "pending") {
    throw Object.assign(new Error(`Deposit berstatus ${dep.status}, tidak bisa di-approve`), { code: "INVALID_STATE" });
  }
  if (!dep.payment_proof_key) {
    throw Object.assign(new Error("Bukti pembayaran belum diunggah"), { code: "NO_PROOF" });
  }

  // 1. Atomic ledger + balance update
  const txResult = await postTransaction(db, {
    userId: dep.user_id,
    referenceId: dep.id,
    transactionType: "deposit",
    amount: dep.amount, // positif = kredit
    idempotencyKey: `dep:${dep.id}`,
    description: `Deposit QRIS ${dep.id}`,
  });

  if (txResult.already_processed && dep.status !== "approved") {
    // ledger sudah ada tapi status belum di-approve (kasus recovery)
    // lanjut update status, tapi tidak buat ledger baru (sudah ada).
  }

  // 2. Update deposit status + audit + notifikasi (atomic batch)
  const t = now();
  const auditRef = dep.id;
  const auditDetails = JSON.stringify({
    deposit_id: dep.id,
    amount: dep.amount,
    ledger_id: txResult.ledger_id,
    user_id: dep.user_id,
  });
  const notifBody = `Deposit ${dep.id} sebesar ${dep.amount / 100} IDR telah diverifikasi dan ditambahkan ke saldo Anda.`;

  await batch(db, [
    {
      sql: `UPDATE deposits
              SET status = 'approved', admin_id = ?, verified_at = ?, ledger_id = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`,
      params: [adminUser.id, t, txResult.ledger_id, t, depositId],
    },
    {
      sql: `INSERT INTO wallet_audit_logs (user_id, admin_id, action, reference_id, details, created_at)
            VALUES (?, ?, 'deposit_approve', ?, ?, ?)`,
      params: [dep.user_id, adminUser.id, auditRef, auditDetails, t],
    },
    {
      sql: `INSERT INTO notifications (user_id, type, title, body, is_read, reference_id, created_at)
            VALUES (?, 'deposit_approved', 'Deposit Disetujui', ?, 0, ?, ?)`,
      params: [dep.user_id, notifBody, dep.id, t],
    },
  ]);

  return {
    deposit_id: dep.id,
    status: "approved",
    amount: dep.amount,
    ledger_id: txResult.ledger_id,
    balance_after: txResult.balance_after,
  };
}

/**
 * REJECT deposit oleh admin.
 * - Saldo TIDAK berubah (tidak ada ledger entry).
 * - Wajib isi alasan.
 * - Catat audit + notifikasi.
 */
export async function rejectDeposit(db, env, depositId, adminUser, reason) {
  if (!canVerifyDeposit(adminUser)) {
    throw Object.assign(new Error("Anda tidak punya hak verifikasi deposit"), { code: "FORBIDDEN" });
  }
  await requireAdmin2FA(db, env, adminUser.id);
  if (!reason || !reason.trim()) {
    throw Object.assign(new Error("Alasan penolakan wajib diisi"), { code: "REASON_REQUIRED" });
  }

  const dep = await first(db, `SELECT id, user_id, amount, status FROM deposits WHERE id = ?`, [depositId]);
  if (!dep) throw new Error("Deposit tidak ditemukan");
  if (dep.status === "rejected") return { already_rejected: true };
  if (dep.status !== "pending") {
    throw Object.assign(new Error(`Deposit berstatus ${dep.status}, tidak bisa di-reject`), { code: "INVALID_STATE" });
  }

  const t = now();
  await batch(db, [
    {
      sql: `UPDATE deposits SET status = 'rejected', admin_id = ?, rejection_reason = ?, verified_at = ?, updated_at = ? WHERE id = ?`,
      params: [adminUser.id, reason.slice(0, 500), t, t, depositId],
    },
    {
      sql: `INSERT INTO wallet_audit_logs (user_id, admin_id, action, reference_id, details, created_at)
            VALUES (?, ?, 'deposit_reject', ?, ?, ?)`,
      params: [dep.user_id, adminUser.id, dep.id, JSON.stringify({ reason }), t],
    },
    {
      sql: `INSERT INTO notifications (user_id, type, title, body, is_read, reference_id, created_at)
            VALUES (?, 'deposit_rejected', 'Deposit Ditolak', ?, 0, ?, ?)`,
      params: [dep.user_id, `Deposit ${dep.id} ditolak: ${reason.slice(0, 100)}`, dep.id, t],
    },
  ]);

  return { deposit_id: dep.id, status: "rejected", reason };
}

/**
 * Cancel deposit oleh user (bila masih pending, belum ada bukti atau
 * setelah upload tapi sebelum verifikasi).
 */
export async function cancelDeposit(db, depositId, userId) {
  const dep = await first(db, `SELECT id, user_id, status FROM deposits WHERE id = ?`, [depositId]);
  if (!dep) throw new Error("Deposit tidak ditemukan");
  if (dep.user_id !== userId) throw Object.assign(new Error("Akses ditolak"), { code: "FORBIDDEN" });
  if (dep.status !== "pending") {
    throw Object.assign(new Error(`Deposit berstatus ${dep.status}, tidak bisa dibatalkan`), { code: "INVALID_STATE" });
  }
  await run(db, `UPDATE deposits SET status = 'cancelled', updated_at = ? WHERE id = ?`, [now(), depositId]);
  return { deposit_id: depositId, status: "cancelled" };
}

/** Daftar deposit user (paginate). */
export async function listUserDeposits(db, userId, { limit = 20, offset = 0 } = {}) {
  const res = await db
    .prepare(`SELECT id, deposit_code, amount, payment_method, payment_proof_key, status, rejection_reason,
                     verified_at, created_at, updated_at
                FROM deposits WHERE user_id = ?
                ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(userId, Math.min(limit, 50), offset)
    .all();
  return res.results || [];
}

/** Ambil detail deposit (hanya pemilik atau admin). */
export async function getDeposit(db, depositId, userId, isAdmin = false) {
  const dep = await first(
    db,
    `SELECT d.id, d.user_id, d.deposit_code, d.amount, d.payment_method, d.payment_proof_key,
            d.payment_proof_mime, d.status, d.rejection_reason, d.verified_at, d.ledger_id,
            d.created_at, d.updated_at, u.username AS user_username
       FROM deposits d JOIN users u ON u.id = d.user_id
      WHERE d.id = ?`,
    [depositId],
  );
  if (!dep) return null;
  if (!isAdmin && dep.user_id !== userId) return null; // IDOR guard
  return dep;
}

/** Daftar deposit pending untuk antrian admin. */
export async function listPendingDeposits(db, { limit = 50, offset = 0 } = {}) {
  const res = await db
    .prepare(`SELECT d.id, d.user_id, u.username, u.email, d.deposit_code, d.amount,
                     d.payment_proof_key, d.payment_proof_mime, d.status, d.created_at
                FROM deposits d JOIN users u ON u.id = d.user_id
               WHERE d.status = 'pending'
               ORDER BY d.created_at ASC LIMIT ? OFFSET ?`)
    .bind(Math.min(limit, 100), offset)
    .all();
  return res.results || [];
}

// ----- RBAC helpers -------------------------------------------------

const DEPOSIT_VERIFIERS = new Set(["super_admin", "admin_deposit"]);

export function canVerifyDeposit(user) {
  return user && DEPOSIT_VERIFIERS.has(user.role);
}

export async function requireAdmin2FA(db, env, userId) {
  const admin = await first(
    db,
    `SELECT two_factor_enabled FROM admin_users WHERE user_id = ?`,
    [userId],
  );
  if (!admin || !admin.two_factor_enabled) {
    throw Object.assign(new Error("2FA wajib diaktifkan sebelum verifikasi deposit"), { code: "2FA_REQUIRED" });
  }
}
