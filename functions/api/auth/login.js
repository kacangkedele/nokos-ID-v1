// functions/api/auth/login.js
import { withHandler, getClientIP, logSecurity } from "../../../src/middleware.js";
import { getDB, first, run } from "../../../src/db.js";
import { verifyPassword } from "../../../src/security.js";
import { createSession, sessionCookies } from "../../../src/session.js";
import { validateLogin } from "../../../src/validation.js";
import { json, now } from "../../../src/utils.js";

export const onRequestPost = withHandler(
  {
    method: "POST",
    rateBucket: "auth_ip",
    csrf: false,
  },
  async (ctx, sess) => {
    const { request, env } = ctx;
    const db = getDB(env);
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: "Body JSON tidak valid" }, 400);

    let clean;
    try {
      clean = validateLogin(body);
    } catch (e) {
      return json({ error: e.message, field: e.field }, 422);
    }

    const user = await first(
      db,
      `SELECT id, username, email, password_hash, role, status, email_verified FROM users WHERE email = ?`,
      [clean.email],
    );

    // constant-time-ish: selalu lakukan verify walau user tidak ada (cegah enumeration)
    const ok = user ? await verifyPassword(clean.password, user.password_hash) : false;
    if (!user || !ok) {
      await logSecurity(db, user?.id || null, "login_failed", `email=${clean.email}`);
      return json({ error: "Email atau password salah." }, 401);
    }
    if (user.status !== "active") {
      return json({ error: `Akun ${user.status}. Hubungi admin.` }, 403);
    }

    // admin wajib 2FA — bila admin & 2FA aktif, minta kode via /api/auth/2fa/verify
    // login awal mengembalikan challenge, bukan session penuh
    const isAdmin = ["super_admin", "admin_deposit", "admin_support", "admin_ops"].includes(user.role);
    const ip = getClientIP(request);
    const ua = request.headers.get("User-Agent");

    if (isAdmin) {
      const adminRow = await first(db, `SELECT two_factor_enabled FROM admin_users WHERE user_id = ?`, [user.id]);
      if (!adminRow || !adminRow.two_factor_enabled) {
        // admin belum setup 2FA → blok login normal, arahkan ke setup (satu kali via super_admin)
        return json({ error: "Admin wajib mengaktifkan 2FA. Hubungi super admin." }, 403);
      }
      // buat session sementara ber-flag 2fa_pending (disimpan di KV, TTL 5 menit)
      const challengeId = crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
      await env.SESSIONS.put(`2fa:${challengeId}`, JSON.stringify({ user_id: user.id, ip, ua, created_at: now() }), { expirationTtl: 300 });
      return json({ ok: true, require_2fa: true, challenge: challengeId, message: "Masukkan kode 2FA." });
    }

    // user biasa: buat session penuh
    const newSess = await createSession(db, env.SESSIONS, user, { ip, ua, revokeOld: true });
    await run(db, `INSERT INTO wallet_audit_logs (user_id, action, reference_id, details, ip, created_at) VALUES (?, 'login', NULL, ?, ?, ?)`,
      [user.id, JSON.stringify({ ua }), ip, now()]);

    return json(
      { ok: true, user: { id: user.id, username: user.username, email: user.email, role: user.role } , csrf_token: newSess.csrf },
      200,
      { "Set-Cookie": sessionCookies(newSess, env).join(", ") },
    );
  },
);
