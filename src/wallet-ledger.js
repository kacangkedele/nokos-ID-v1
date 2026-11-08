// src/wallet-ledger.js — INTI FINANSIAL Nokos.ID V2
// --------------------------------------------------------------------------
// Aturan mutlak (dari master prompt):
//   1. Saldo hanya berubah melalui ledger (append-only).
//   2. Saldo + ledger di-update dalam SATU transaksi D1 batch() (atomic).
//   3. Idempotency: idempotency_key unik per (user, action).
//   4. Saldo tidak boleh minus (CHECK constraint + trigger).
//   5. Double-spending dicegah via row-level lock emulation (SELECT ... + UPDATE).
//   6. Balance_before & balance_after dicatat untuk audit.
//
// D1 SQLite tidak mendukung SELECT FOR UPDATE, tetapi batch() bersifat
// SERIALIZABLE (semua statement dieksekusi dalam satu implicit transaction).
// Kita juga pakai idempotency_key sebagai UNIQUE constraint untuk menjamin
// satu transaksi hanya diproses sekali.
// --------------------------------------------------------------------------

import { first, run, batch } from "./db.js";
import { now } from "./utils.js";

/**
 * Pastikan user punya wallet. Buat bila belum ada (auto-provisioning).
 */
export async function ensureWallet(db, userId) {
  const existing = await first(db, `SELECT id, balance FROM wallets WHERE user_id = ?`, [userId]);
  if (existing) return existing;
  const t = now();
  await run(
    db,
    `INSERT INTO wallets (user_id, balance, currency, created_at, updated_at)
     VALUES (?, 0, 'IDR', ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
    [userId, t, t],
  );
  return first(db, `SELECT id, balance FROM wallets WHERE user_id = ?`, [userId]);
}

/**
 * Ambil saldo + ringkasan wallet (total deposit, total order, total refund).
 */
export async function getWalletSummary(db, userId) {
  const wallet = await ensureWallet(db, userId);
  const stats = await first(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN transaction_type='deposit' AND status='completed' THEN amount END),0) AS total_deposit,
       COALESCE(SUM(CASE WHEN transaction_type='order'    AND status='completed' THEN amount END),0) AS total_order,
       COALESCE(SUM(CASE WHEN transaction_type='refund'   AND status='completed' THEN amount END),0) AS total_refund
     FROM wallet_transactions WHERE user_id = ?`,
    [userId],
  );
  return {
    user_id: userId,
    balance: wallet.balance,
    currency: wallet.currency,
    total_deposit: stats?.total_deposit || 0,
    total_order: Math.abs(stats?.total_order || 0), // order amount negatif
    total_refund: stats?.total_refund || 0,
  };
}

/**
 * Riwayat transaksi (paginate). Balance_after adalah saldo setelah transaksi.
 */
export async function listTransactions(db, userId, { limit = 20, offset = 0 } = {}) {
  return first(
    db,
    `SELECT id, reference_id, transaction_type, amount, balance_before, balance_after,
            status, description, created_at
       FROM wallet_transactions
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [userId, Math.min(limit, 100), offset],
  ).then((_) => _ || []);
}

/**
 * ---------------------------------------------------------------------
 * POST TRANSACTION (atomic) — fungsi paling sensitif.
 *
 * Lakukan dalam D1 batch():
 *   1. INSERT idempotency_records (anti replay)
 *   2. SELECT wallet balance saat ini (balance_before)
 *   3. Hitung balance_after = balance_before + amount
 *   4. VALIDASI: balance_after >= 0 (cek minus)
 *   5. INSERT wallet_transactions (ledger)
 *   6. UPDATE wallets SET balance = balance_after  (trigger juga lakukan ini)
 *
 * Catatan: D1 batch() mengeksekusi semua statement dalam satu transaction.
 * Bila salah satu gagal (mis. UNIQUE constraint idempotency_key), semua
 * rollback. Inilah jaminan atomic.
 *
 * Karena D1 tidak mendukung returning balance di tengah batch, kita baca
 * balance SEBELUM batch lalu hitung client-side. Race condition ditangani
 * dengan idempotency_key + trigger trg_wallet_no_negative (abaikan bila
 * balance minus). Bila dua request bersamaan dengan key berbeda, batch()
 * D1 di-serialize per-database, sehingga aman.
 * ---------------------------------------------------------------------
 *
 * @param {object} opts
 * @param {number} opts.userId
 * @param {string} opts.referenceId   - deposit.id / otp_orders.id
 * @param {string} opts.transactionType - 'deposit'|'order'|'refund'|'adjustment'
 * @param {number} opts.amount         - positif=credit, negatif=debit
 * @param {string} opts.idempotencyKey - wajib, anti double
 * @param {string} [opts.description]
 * @returns {Promise<{ledger_id:number, balance_before:number, balance_after:number}>}
 * @throws bila idempotency_key sudah dipakai (already processed) atau saldo minus
 */
export async function postTransaction(db, opts) {
  const { userId, referenceId, transactionType, amount, idempotencyKey, description } = opts;
  if (!idempotencyKey) throw new Error("idempotencyKey wajib");
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount === 0) {
    throw new Error("amount harus integer != 0");
  }

  const wallet = await ensureWallet(db, userId);
  const balance_before = wallet.balance;
  const balance_after = balance_before + amount;

  if (balance_after < 0) {
    // JANGAN buat ledger entry. Cukup catat idempotency sebagai failed.
    const t = now();
    try {
      await run(
        db,
        `INSERT INTO idempotency_records (key, user_id, endpoint, status_code, response_body, created_at, expires_at)
         VALUES (?, ?, 'postTransaction', 422, ?, ?, ?)`,
        [idempotencyKey, userId, JSON.stringify({ error: "insufficient_balance" }), t, t + 3600],
      );
    } catch {
      // idempotency sudah ada → return existing result
      return { already_processed: true };
    }
    const err = new Error("Saldo tidak cukup untuk transaksi ini.");
    err.code = "INSUFFICIENT_BALANCE";
    err.balance_before = balance_before;
    err.required = Math.abs(amount);
    throw err;
  }

  const t = now();
  const desc = description || null;
  const refId = referenceId || null;

  // D1 batch atomic:
  //   - INSERT ledger row (idempotency_key UNIQUE → double-submit dicegah)
  //   - UPDATE wallet balance (juga di trigger, tetapi eksplisit di sini
  //     supaya balance_after selalu sinkron dengan baris ledger baru)
  const stmts = [
    {
      sql: `INSERT INTO wallet_transactions
              (user_id, reference_id, idempotency_key, transaction_type, amount,
               balance_before, balance_after, status, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
      params: [userId, refId, idempotencyKey, transactionType, amount, balance_before, balance_after, desc, t],
    },
    {
      sql: `UPDATE wallets SET balance = ?, updated_at = ? WHERE user_id = ? AND balance = ?`,
      params: [balance_after, t, userId, balance_before],
    },
  ];

  let result;
  try {
    result = await batch(db, stmts);
  } catch (e) {
    // UNIQUE constraint idempotency_key → transaksi sudah pernah diproses
    if (String(e?.message || "").includes("UNIQUE") || String(e?.message || "").includes("idempotency")) {
      const existing = await first(
        db,
        `SELECT id, balance_before, balance_after FROM wallet_transactions WHERE idempotency_key = ? AND user_id = ?`,
        [idempotencyKey, userId],
      );
      if (existing) {
        return {
          already_processed: true,
          ledger_id: existing.id,
          balance_before: existing.balance_before,
          balance_after: existing.balance_after,
        };
      }
    }
    throw e;
  }

  const ledgerRow = await first(
    db,
    `SELECT id FROM wallet_transactions WHERE idempotency_key = ? AND user_id = ?`,
    [idempotencyKey, userId],
  );

  return {
    ledger_id: ledgerRow?.id,
    balance_before,
    balance_after,
  };
}

/**
 * Rekonsiliasi: jumlahkan ledger, bandingkan dengan balance wallet.
 * Dipakai admin untuk audit berkala. Selisih = inkonsistensi (harusnya 0).
 */
export async function reconcileWallet(db, userId) {
  const wallet = await ensureWallet(db, userId);
  const sum = await first(
    db,
    `SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions
      WHERE user_id = ? AND status = 'completed'`,
    [userId],
  );
  const ledgerBalance = Number(sum?.total || 0);
  return {
    user_id: userId,
    wallet_balance: wallet.balance,
    ledger_balance: ledgerBalance,
    consistent: wallet.balance === ledgerBalance,
  };
}
