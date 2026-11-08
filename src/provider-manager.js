// src/provider-manager.js — CRUD + test + balance + monitoring untuk admin.
//
// Aturan keamanan (master prompt 17.B & 17.J):
//   - API key TIDAK pernah disimpan di DB; hanya api_key_secret_name (referensi Cloudflare Secret).
//   - Provider tidak bisa diaktifkan sebelum test koneksi berhasil (last_test_ok=1).
//   - Hanya super_admin yang bisa CRUD provider.
//   - Default provider: hanya satu provider boleh is_default=1.
//   - Hapus provider: status wajib 'disabled' dulu (soft safety).

import { first, run, all, batch } from "./db.js";
import { now, ulid } from "./utils.js";
import { getAdapter, getProviderConfig } from "./providers/registry.js";
import { ProviderError } from "./providers/base.js";

const REQUIRED_FIELDS = ["provider_code", "provider_name", "base_url", "api_key_secret_name"];

/** List semua provider (untuk admin dashboard). */
export async function listProviders(db) {
  const res = await db
    .prepare(`SELECT id, provider_code, provider_name, display_name, base_url, auth_method,
                     api_key_secret_name, status, priority, is_default, markup_percent,
                     timeout_ms, max_retries, last_test_at, last_test_ok, last_balance_cents,
                     last_balance_at, created_at, updated_at
                FROM providers ORDER BY priority ASC, is_default DESC`)
    .all();
  return res.results || [];
}

/** Ambil 1 provider (untuk edit / detail). */
export async function getProvider(db, id) {
  return first(db, `SELECT * FROM providers WHERE id = ?`, [id]);
}

/** Buat provider baru. Selalu inactive sampai test koneksi. */
export async function createProvider(db, payload, adminId) {
  validatePayload(payload);
  await ensureUniqueCode(db, payload.provider_code);
  const t = now();
  // API key tidak pernah disimpan — hanya nama secret
  const configuration = payload.configuration
    ? typeof payload.configuration === "string"
      ? payload.configuration
      : JSON.stringify(payload.configuration)
    : JSON.stringify({ paths: {} });
  const res = await run(
    db,
    `INSERT INTO providers
      (provider_code, provider_name, display_name, base_url, auth_method, auth_header_name,
       api_key_secret_name, auth_in_query_param, status, priority, is_default,
       markup_percent, timeout_ms, max_retries, configuration, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'inactive', ?, 0, ?, ?, ?, ?, ?, ?)`,
    [
      payload.provider_code, payload.provider_name, payload.display_name || null, payload.base_url,
      payload.auth_method || "bearer", payload.auth_header_name || null,
      payload.api_key_secret_name, payload.auth_in_query_param || null,
      payload.priority || 100,
      payload.markup_percent ?? 15, payload.timeout_ms || 10000, payload.max_retries ?? 2,
      configuration, t, t,
    ],
  );
  const id = res.meta.last_row_id;
  await audit(db, adminId, "provider_create", `provider:${payload.provider_code}`, { id, ...payload });
  return { id, ...payload, status: "inactive" };
}

/** Update provider. */
export async function updateProvider(db, id, payload, adminId) {
  const existing = await getProvider(db, id);
  if (!existing) throw Object.assign(new Error("Provider tidak ditemukan"), { code: "NOT_FOUND" });
  const t = now();
  const fields = [];
  const params = [];
  const allowed = ["provider_name", "display_name", "base_url", "auth_method", "auth_header_name",
    "api_key_secret_name", "auth_in_query_param", "priority", "markup_percent",
    "timeout_ms", "max_retries", "configuration"];
  for (const f of allowed) {
    if (payload[f] !== undefined) {
      fields.push(`${f} = ?`);
      params.push(f === "configuration" && typeof payload[f] !== "string" ? JSON.stringify(payload[f]) : payload[f]);
    }
  }
  if (payload.status !== undefined) {
    // bila ingin set active, wajib last_test_ok
    if (payload.status === "active" && !existing.last_test_ok) {
      throw Object.assign(
        new Error("Provider belum lolos test koneksi. Jalankan test koneksi dulu."),
        { code: "TEST_REQUIRED" },
      );
    }
    fields.push("status = ?");
    params.push(payload.status);
  }
  if (payload.is_default === true || payload.is_default === 1) {
    // reset default lain
    await run(db, `UPDATE providers SET is_default = 0, updated_at = ? WHERE id != ?`, [t, id]);
    fields.push("is_default = 1");
  } else if (payload.is_default === false || payload.is_default === 0) {
    fields.push("is_default = 0");
  }
  if (fields.length === 0) return existing;
  fields.push("updated_at = ?");
  params.push(t, id);
  await run(db, `UPDATE providers SET ${fields.join(", ")} WHERE id = ?`, params);
  await audit(db, adminId, "provider_update", `provider:${existing.provider_code}`, payload);
  return getProvider(db, id);
}

/** Hapus provider (hanya bila status=disabled). */
export async function deleteProvider(db, id, adminId) {
  const p = await getProvider(db, id);
  if (!p) throw Object.assign(new Error("Provider tidak ditemukan"), { code: "NOT_FOUND" });
  if (p.status !== "disabled") {
    throw Object.assign(
      new Error("Provider harus dinonaktifkan (status=disabled) sebelum dihapus."),
      { code: "INVALID_STATE" },
    );
  }
  // cek apakah ada order terkait
  const orders = await first(db, `SELECT COUNT(*) AS n FROM otp_orders WHERE provider_id = ?`, [id]);
  if (orders?.n > 0) {
    throw Object.assign(
      new Error(`Provider memiliki ${orders.n} order terkait. Tidak bisa dihapus — set status=disabled saja.`),
      { code: "HAS_ORDERS" },
    );
  }
  await run(db, `DELETE FROM providers WHERE id = ?`, [id]);
  await audit(db, adminId, "provider_delete", `provider:${p.provider_code}`, { id });
  return { deleted: true };
}

/**
 * Test koneksi provider: panggil getCountries() via adapter (force=true untuk bypass status).
 * Update last_test_at, last_test_ok.
 */
export async function testConnection(env, id, adminId) {
  const adapter = await getAdapter(env, id, { force: true });
  const result = await adapter.testConnection();
  const t = now();
  await run(
    env.DB,
    `UPDATE providers SET last_test_at = ?, last_test_ok = ?, updated_at = ? WHERE id = ?`,
    [t, result.ok ? 1 : 0, t, id],
  );
  await audit(env.DB, adminId, "provider_test", `provider:${adapter.code}`, { ok: result.ok, error: result.error });
  return { ok: result.ok, sample: result.sample, error: result.error, code: result.code, tested_at: t };
}

/** Ambil saldo provider (bila API dukung). */
export async function fetchBalance(env, id, adminId) {
  const adapter = await getAdapter(env, id, { force: true });
  const bal = await adapter.getBalance();
  const t = now();
  if (bal !== null && bal !== undefined) {
    await run(env.DB, `UPDATE providers SET last_balance_cents = ?, last_balance_at = ?, updated_at = ? WHERE id = ?`,
      [bal, t, t, id]);
  }
  await audit(env.DB, adminId, "provider_balance", `provider:${adapter.code}`, { balance_cents: bal });
  return { balance_cents: bal, fetched_at: t };
}

/** Statistik provider untuk admin dashboard. */
export async function providerStats(db) {
  const totals = await first(
    db,
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status='inactive' THEN 1 ELSE 0 END) AS inactive,
      SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS disabled,
      SUM(CASE WHEN status='degraded' THEN 1 ELSE 0 END) AS degraded
     FROM providers`,
  );
  // per-provider: total order, success rate, avg response time, pending, failed
  const perProvider = await all(
    db,
    `SELECT p.id, p.provider_code, p.provider_name, p.status, p.last_test_ok,
            (SELECT COUNT(*) FROM otp_orders WHERE provider_id = p.id) AS total_orders,
            (SELECT COUNT(*) FROM otp_orders WHERE provider_id = p.id AND status='completed') AS completed_orders,
            (SELECT COUNT(*) FROM otp_orders WHERE provider_id = p.id AND status='failed') AS failed_orders,
            (SELECT COUNT(*) FROM otp_orders WHERE provider_id = p.id AND status='pending') AS pending_orders,
            (SELECT COUNT(*) FROM provider_logs WHERE provider_id = p.id AND success=1) AS successful_calls,
            (SELECT COUNT(*) FROM provider_logs WHERE provider_id = p.id AND success=0) AS failed_calls,
            (SELECT AVG(duration_ms) FROM provider_logs WHERE provider_id = p.id) AS avg_response_ms
       FROM providers p
       ORDER BY p.priority ASC`,
  );
  return { totals, per_provider: perProvider };
}

// ---- helpers --------------------------------------------------------

function validatePayload(p) {
  for (const f of REQUIRED_FIELDS) {
    if (!p[f]) throw Object.assign(new Error(`Field '${f}' wajib diisi`), { code: "VALIDATION", field: f });
  }
  if (!/^[a-z0-9_]{3,30}$/.test(p.provider_code)) {
    throw Object.assign(new Error("provider_code: 3-30 char alfanumerik + underscore, lowercase"), { code: "VALIDATION", field: "provider_code" });
  }
  if (!/^https?:\/\//.test(p.base_url)) {
    throw Object.assign(new Error("base_url harus diawali http:// atau https://"), { code: "VALIDATION", field: "base_url" });
  }
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(p.api_key_secret_name)) {
    throw Object.assign(new Error("api_key_secret_name: nama secret (uppercase, underscore) — bukan nilai API key"), { code: "VALIDATION", field: "api_key_secret_name" });
  }
}

async function ensureUniqueCode(db, code) {
  const exists = await first(db, `SELECT id FROM providers WHERE provider_code = ?`, [code]);
  if (exists) throw Object.assign(new Error(`provider_code '${code}' sudah dipakai`), { code: "DUPLICATE" });
}

async function audit(db, adminId, action, reference, details) {
  try {
    await run(
      db,
      `INSERT INTO wallet_audit_logs (admin_id, action, reference_id, details, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [adminId || null, action, reference, JSON.stringify(details || {}), now()],
    );
  } catch {}
}
