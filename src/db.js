// src/db.js — koneksi D1 + query helper
// Semua query memakai binding parameterized (anti SQL injection).

/**
 * Ambil binding D1 dari context (Pages Functions).
 * @param {any} env - env dari onRequest(context)
 */
export function getDB(env) {
  if (!env?.DB) throw new Error("D1 binding 'DB' tidak tersedia. Jalankan via wrangler.");
  return env.DB;
}

/**
 * Helper untuk menjalankan beberapa statement dalam satu transaction D1.
 * D1 mendukung batch() yang atomic (semua sukses atau semua rollback).
 *
 * @param {D1Database} db
 * @param {Array<{sql:string, params?:any[]}>} stmts
 * @returns result array
 */
export async function batch(db, stmts) {
  const prepared = stmts.map((s) => db.prepare(s.sql).bind(...(s.params || [])));
  return db.batch(prepared);
}

/**
 * Eksekusi satu statement. Return meta (changes, last_row_id).
 */
export async function run(db, sql, params = []) {
  return db.prepare(sql).bind(...params).run();
}

/**
 * Ambil satu baris. Return undefined bila tidak ada.
 */
export async function first(db, sql, params = []) {
  return db.prepare(sql).bind(...params).first();
}

/**
 * Ambil banyak baris.
 */
export async function all(db, sql, params = []) {
  const res = await db.prepare(sql).bind(...params).all();
  return res.results || [];
}
