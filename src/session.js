// src/session.js — session cookie management (server-side revocable)
//
// Cookie: nokos_sid = random 32-byte hex. Sesi disimpan di tabel `sessions`
// + cache di KV `SESSIONS`. Bukan JWT — agar bisa di-revoke dari panel admin.
//
// Cookie flags: HttpOnly, Secure (production), SameSite=Lax, Path=/.
// CSRF: double-submit token di cookie terpisah `nokos_csrf`, dicocokkan dengan
// header `X-CSRF-Token` pada POST/PUT/DELETE.

import { randomHex, now } from "./utils.js";
import { first, run, all } from "./db.js";

const SESSION_TTL = 7 * 24 * 3600; // 7 hari (detik)
const COOKIE_SID = "nokos_sid";
const COOKIE_CSRF = "nokos_csrf";

function isProd(env) {
  return env?.ENVIRONMENT === "production" || !env?.ENVIRONMENT;
}

/** Set cookie dengan flag aman. */
function setCookie(name, value, maxAge, secure) {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Lax",
    secure ? "Secure" : "",
    "HttpOnly",
  ].filter(Boolean);
  return parts.join("; ");
}

/**
 * Buat sesi baru untuk user. Hapus sesi lama user (opsional).
 */
export async function createSession(db, kv, user, { ip, ua, revokeOld = false } = {}) {
  const sid = randomHex(32);
  const csrf = randomHex(32);
  const t = now();
  const expiresAt = t + SESSION_TTL;

  if (revokeOld) {
    await run(db, `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [t, user.id]);
  }
  await run(
    db,
    `INSERT INTO sessions (id, user_id, csrf_token, ip, ua, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sid, user.id, csrf, ip || null, ua || null, t, expiresAt],
  );
  // cache di KV untuk lookup cepat
  if (kv) {
    await kv.put(`sess:${sid}`, JSON.stringify({ user_id: user.id, csrf, expiresAt }), {
      expirationTtl: SESSION_TTL,
    });
  }
  return { sid, csrf, expiresAt };
}

/**
 * Verifikasi sesi dari request. Return { user, csrf } atau null.
 */
export async function getSession(db, kv, req) {
  const cookies = parseCookies(req.headers.get("Cookie") || "");
  const sid = cookies[COOKIE_SID];
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;

  let userId = null;
  let csrf = null;
  // cek KV cache dulu
  if (kv) {
    const cached = await kv.get(`sess:${sid}`);
    if (cached) {
      try {
        const obj = JSON.parse(cached);
        if (obj.expiresAt > now()) {
          userId = obj.user_id;
          csrf = obj.csrf;
        }
      } catch {}
    }
  }
  // fallback ke DB
  if (!userId) {
    const row = await first(
      db,
      `SELECT s.user_id, s.csrf_token, s.expires_at, s.revoked_at,
              u.id, u.username, u.email, u.role, u.status, u.email_verified
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
      [sid],
    );
    if (!row || row.revoked_at || row.expires_at <= now() || row.status !== "active") {
      return null;
    }
    userId = row.user_id;
    csrf = row.csrf_token;
    // re-cache
    if (kv) {
      const ttl = row.expires_at - now();
      if (ttl > 0) {
        await kv.put(`sess:${sid}`, JSON.stringify({ user_id: userId, csrf, expiresAt: row.expires_at }), {
          expirationTtl: ttl,
        });
      }
    }
    return {
      sid,
      user: {
        id: row.id,
        username: row.username,
        email: row.email,
        role: row.role,
        status: row.status,
        email_verified: row.email_verified,
      },
      csrf,
    };
  }

  // ambil user dari DB (data bisa berubah)
  const user = await first(db, `SELECT id, username, email, role, status, email_verified FROM users WHERE id = ?`, [userId]);
  if (!user || user.status !== "active") return null;
  return { sid, user, csrf };
}

/**
 * Hapus sesi (logout). Hapus dari DB + KV.
 */
export async function destroySession(db, kv, req) {
  const cookies = parseCookies(req.headers.get("Cookie") || "");
  const sid = cookies[COOKIE_SID];
  if (!sid) return;
  await run(db, `UPDATE sessions SET revoked_at = ? WHERE id = ?`, [now(), sid]);
  if (kv) await kv.delete(`sess:${sid}`);
}

/** Logout semua perangkat user. */
export async function destroyAllSessions(db, kv, userId) {
  await run(db, `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [now(), userId]);
  // KV cleanup terbatas (tidak bisa list by user); biarkan TTL expire.
}

export function parseCookies(header) {
  const out = {};
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

/** Verifikasi CSRF token: cookie csrf == header X-CSRF-Token. */
export function verifyCSRF(req, session) {
  if (!session?.csrf) return false;
  const header = req.headers.get("X-CSRF-Token");
  if (!header) return false;
  return header === session.csrf;
}

/** Header Set-Cookie untuk sesi baru. */
export function sessionCookies({ sid, csrf }, env) {
  const secure = isProd(env);
  return [
    setCookie(COOKIE_SID, sid, SESSION_TTL, secure),
    // CSRF cookie TIDAK HttpOnly supaya JS bisa baca untuk attach ke header
    `${COOKIE_CSRF}=${csrf}; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax${secure ? "; Secure" : ""}`,
  ];
}

/** Header Set-Cookie expire (logout). */
export function clearCookies(env) {
  const secure = isProd(env);
  return [
    `${COOKIE_SID}=; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}; HttpOnly`,
    `${COOKIE_CSRF}=; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`,
  ];
}

export const COOKIE_NAMES = { SID: COOKIE_SID, CSRF: COOKIE_CSRF };
