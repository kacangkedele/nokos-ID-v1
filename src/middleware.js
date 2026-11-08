// src/middleware.js — helper untuk semua Pages Functions endpoint
// Menyatukan: parsing, session, CSRF, rate-limit, RBAC, audit, error handling.

import { getDB } from "./db.js";
import { getSession, verifyCSRF } from "./session.js";
import { rateLimit } from "./rate-limit.js";
import { json } from "./utils.js";
import { run } from "./db.js";
import { now } from "./utils.js";
import { loadSettings } from "./settings.js";

/**
 * Wrapper untuk handler Pages Function.
 *
 * @param {object} opts
 * @param {string} [opts.method] - 'GET'|'POST'|... (bila perlu restrict)
 * @param {boolean} [opts.auth] - butuh login
 * @param {boolean} [opts.admin] - butuh role admin
 * @param {string[]} [opts.roles] - whitelist role admin
 * @param {string} [opts.rateBucket] - bucket rate-limit
 * @param {boolean} [opts.csrf] - butuh CSRF token (POST/PUT/DELETE)
 * @param {function} handler - (ctx, sess) => Response
 */
export function withHandler(opts, handler) {
  return async (ctx) => {
    const { request, env } = ctx;
    const db = getDB(env);

    // method check
    if (opts.method && request.method !== opts.method) {
      return json({ error: "Method not allowed" }, 405, { Allow: opts.method });
    }

    // rate limit
    if (opts.rateBucket) {
      const id = opts.rateIdFrom ? opts.rateIdFrom(ctx) : getClientIP(request);
      const rl = await rateLimit(env.RATE_LIMIT, opts.rateBucket, id);
      if (!rl.ok) {
        return json({ error: "Rate limit terlampaui. Coba lagi nanti.", reset_in: rl.reset }, 429);
      }
    }

    // auth
    let sess = null;
    if (opts.auth || opts.admin) {
      sess = await getSession(db, env.SESSIONS, request);
      if (!sess) {
        return json({ error: "Unauthorized. Silakan login." }, 401);
      }
      if (opts.admin && !isAdminRole(sess.user.role)) {
        await logSecurity(db, sess.user.id, "privilege_denied", `endpoint=${ctx.params?.id || ctx.url?.pathname || ""}`);
        return json({ error: "Forbidden. Hak admin diperlukan." }, 403);
      }
      if (opts.roles && !opts.roles.includes(sess.user.role)) {
        await logSecurity(db, sess.user.id, "privilege_denied", `roles=${opts.roles.join(",")}`);
        return json({ error: "Forbidden. Role tidak diizinkan." }, 403);
      }
    }

    // CSRF (untuk mutasi)
    if (opts.csrf && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      if (!sess || !verifyCSRF(request, sess)) {
        return json({ error: "Token CSRF tidak valid." }, 403);
      }
    }

    try {
      // preload settings ke env lazy
      const settings = await loadSettings(db);
      ctx.settings = settings;
      return await handler(ctx, sess);
    } catch (e) {
      return handleError(e, sess, env);
    }
  };
}

function isAdminRole(role) {
  return ["super_admin", "admin_deposit", "admin_support", "admin_ops"].includes(role);
}

export function getClientIP(request) {
  const xff = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("X-Real-IP") || "unknown";
}

export async function logSecurity(db, userId, type, details) {
  try {
    await run(
      db,
      `INSERT INTO security_events (user_id, event_type, severity, ip, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, type, "warn", null, details, now()],
    );
  } catch {}
}

export async function logAudit(db, { userId, adminId, action, referenceId, details, ip }) {
  try {
    await run(
      db,
      `INSERT INTO wallet_audit_logs (user_id, admin_id, action, reference_id, details, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId || null, adminId || null, action, referenceId || null, typeof details === "string" ? details : JSON.stringify(details || {}), ip || null, now()],
    );
  } catch {}
}

function handleError(e, sess, env) {
  const code = e?.code;
  const status = mapStatus(code, e);
  const body = { error: e.message || "Internal server error" };
  if (code) body.code = code;
  // Jangan bocorkan stack trace di production
  if (isProd(env) && status >= 500) {
    body.error = "Terjadi kesalahan server. Tim sudah diberi notifikasi.";
    body.detail = "internal_error";
  }
  console.error("[api-error]", code || "", e.message, e.stack?.split("\n")[1] || "");
  return json(body, status);
}

function mapStatus(code, e) {
  if (code === "FORBIDDEN") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "INSUFFICIENT_BALANCE") return 422;
  if (code === "INVALID_STATE") return 409;
  if (code === "2FA_REQUIRED") return 403;
  if (code === "PROVIDER_NOT_CONFIGURED" || code === "PROVIDER_DISABLED") return 503;
  if (code === "PROVIDER_UNREACHABLE") return 502;
  if (code === "NO_PROOF" || code === "REASON_REQUIRED") return 400;
  if (e?.name === "ValidationError") return 422;
  return 500;
}

function env_isProd() {
  // ctx.env tidak tersedia di handler error; default konservatif true
  return true;
}

function isProd(env) {
  return env?.ENVIRONMENT === "production" || !env?.ENVIRONMENT;
}
