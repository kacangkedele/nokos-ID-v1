// functions/api/auth/2fa/verify.js
// Verifikasi kode 2FA. Dua mode:
//   1. Saat setup: aktifkan 2FA bila kode benar.
//   2. Saat login admin: challenge → session penuh bila kode benar.
import { withHandler, logSecurity, getClientIP } from "../../../../src/middleware.js";
import { getDB, first, run } from "../../../../src/db.js";
import { decryptSecret, verifyPassword, hashRecoveryCode } from "../../../../src/security.js";
import { verifyTOTP } from "../../../../src/totp.js";
import { createSession, sessionCookies, destroySession } from "../../../../src/session.js";
import { validateTOTPCode, validateRecoveryCode } from "../../../../src/validation.js";
import { json, now } from "../../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", csrf: false, rateBucket: "auth_ip" },
  async (ctx, sess) => {
    const { request, env } = ctx;
    const db = getDB(env);
    const body = await request.json().catch(() => null);
    if (!body?.challenge && !sess) return json({ error: "Tidak ada challenge atau session." }, 400);

    const code = body.code;
    const recovery = body.recovery_code;

    // ----- Mode 1: verifikasi setup (user sudah login) -----
    if (sess && !body.challenge) {
      const admin = await first(db, `SELECT * FROM admin_users WHERE user_id = ?`, [sess.user.id]);
      if (!admin) return json({ error: "Bukan admin." }, 403);
      if (admin.two_factor_enabled) {
        return json({ error: "2FA sudah aktif." }, 409);
      }
      if (!admin.two_factor_secret_enc) return json({ error: "Setup 2FA belum dimulai. Panggil /api/auth/2fa/setup." }, 400);

      const secret = await decryptSecret({ ct: admin.two_factor_secret_enc, iv: admin.two_factor_iv }, env);
      const ok = await verifyTOTP(secret, code);
      if (!ok) {
        await logSecurity(db, sess.user.id, "2fa_failed", "setup-verify");
        return json({ error: "Kode 2FA salah." }, 401);
      }
      await run(db, `UPDATE admin_users SET two_factor_enabled = 1 WHERE user_id = ?`, [sess.user.id]);
      await logSecurity(db, sess.user.id, "2fa_enabled", "setup-completed");
      return json({ ok: true, message: "2FA aktif." });
    }

    // ----- Mode 2: verifikasi login admin (challenge) -----
    const challenge = body.challenge;
    if (challenge) {
      const raw = await env.SESSIONS.get(`2fa:${challenge}`);
      if (!raw) return json({ error: "Challenge kedaluwarsa. Silakan login ulang." }, 401);
      await env.SESSIONS.delete(`2fa:${challenge}`); // one-time use
      const obj = JSON.parse(raw);
      const user = await first(db, `SELECT id, username, email, role, status FROM users WHERE id = ?`, [obj.user_id]);
      if (!user || user.status !== "active") return json({ error: "Akun tidak aktif." }, 403);

      const admin = await first(db, `SELECT * FROM admin_users WHERE user_id = ?`, [user.id]);
      if (!admin || !admin.two_factor_enabled) {
        return json({ error: "2FA belum diaktifkan." }, 403);
      }

      const secret = await decryptSecret({ ct: admin.two_factor_secret_enc, iv: admin.two_factor_iv }, env);
      let verified = false;
      if (code) {
        try { validateTOTPCode(code); } catch (e) { return json({ error: e.message }, 422); }
        verified = await verifyTOTP(secret, code);
      } else if (recovery) {
        try { validateRecoveryCode(recovery); } catch (e) { return json({ error: e.message }, 422); }
        const hashes = JSON.parse(admin.recovery_codes_hash || "[]");
        for (let i = 0; i < hashes.length; i++) {
          if (hashes[i] === (await hashRecoveryCode(recovery))) {
            verified = true;
            hashes[i] = "USED";
            await run(db, `UPDATE admin_users SET recovery_codes_hash = ?, recovery_codes_used = recovery_codes_used + 1 WHERE user_id = ?`,
              [JSON.stringify(hashes), user.id]);
            break;
          }
        }
      }
      if (!verified) {
        await logSecurity(db, user.id, "2fa_failed", `login challenge=${challenge.slice(0, 8)}`);
        return json({ error: "Kode 2FA atau recovery code salah." }, 401);
      }

      await run(db, `UPDATE admin_users SET last_2fa_at = ? WHERE user_id = ?`, [now(), user.id]);
      const newSess = await createSession(db, env.SESSIONS, user, {
        ip: getClientIP(request),
        ua: request.headers.get("User-Agent"),
        revokeOld: true,
      });
      return json(
        { ok: true, user: { id: user.id, username: user.username, email: user.email, role: user.role }, csrf_token: newSess.csrf },
        200,
        { "Set-Cookie": sessionCookies(newSess, env).join(", ") },
      );
    }

    // ----- Mode 3: re-auth untuk aksi sensitif (sudah login, verifikasi ulang) -----
    if (sess) {
      const admin = await first(db, `SELECT * FROM admin_users WHERE user_id = ?`, [sess.user.id]);
      if (!admin || !admin.two_factor_enabled) return json({ error: "2FA belum aktif." }, 403);
      const secret = await decryptSecret({ ct: admin.two_factor_secret_enc, iv: admin.two_factor_iv }, env);
      const ok = await verifyTOTP(secret, code);
      if (!ok) {
        await logSecurity(db, sess.user.id, "2fa_failed", "re-auth");
        return json({ error: "Kode 2FA salah." }, 401);
      }
      await run(db, `UPDATE admin_users SET last_2fa_at = ? WHERE user_id = ?`, [now(), sess.user.id]);
      return json({ ok: true, reauth: true });
    }

    return json({ error: "Permintaan tidak valid." }, 400);
  },
);
