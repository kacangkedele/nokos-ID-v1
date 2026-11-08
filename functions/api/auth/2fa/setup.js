// functions/api/auth/2fa/setup.js
// Inisiasi setup 2FA untuk admin. Generate secret + recovery codes,
// simpan terenkripsi, return otpauth URI untuk QR code.
import { withHandler, logSecurity } from "../../../../src/middleware.js";
import { getDB, first, run } from "../../../../src/db.js";
import { encryptSecret, hashRecoveryCode } from "../../../../src/security.js";
import { generateTOTPSecret, otpauthURI, generateRecoveryCodes } from "../../../../src/totp.js";
import { json, now } from "../../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", auth: true, admin: true, csrf: true },
  async (ctx, sess) => {
    const { env, request } = ctx;
    const db = getDB(env);

    // hanya admin yang belum aktif 2FA (atau super_admin regenerate)
    let admin = await first(db, `SELECT * FROM admin_users WHERE user_id = ?`, [sess.user.id]);
    if (!admin) {
      // admin record belum ada → buat (berdasarkan role users)
      const t = now();
      await run(db, `INSERT INTO admin_users (user_id, role, created_at) VALUES (?, ?, ?)`,
        [sess.user.id, sess.user.role, t]);
      admin = await first(db, `SELECT * FROM admin_users WHERE user_id = ?`, [sess.user.id]);
    }
    if (admin.two_factor_enabled && sess.user.role !== "super_admin") {
      return json({ error: "2FA sudah aktif. Hubungi super admin untuk regenerate." }, 409);
    }

    const secret = generateTOTPSecret();
    const enc = await encryptSecret(secret, env);
    const recoveryCodes = generateRecoveryCodes(10);
    const hashes = [];
    for (const c of recoveryCodes) hashes.push(await hashRecoveryCode(c));

    const t = now();
    await run(
      db,
      `UPDATE admin_users
          SET two_factor_secret_enc = ?, two_factor_iv = ?, two_factor_setup_at = ?,
              recovery_codes_hash = ?, recovery_codes_used = 0, two_factor_enabled = 0
        WHERE user_id = ?`,
      [enc.ct, enc.iv, t, JSON.stringify(hashes), sess.user.id],
    );

    await logSecurity(db, sess.user.id, "2fa_setup_initiated", `user=${sess.user.username}`);

    const uri = otpauthURI(secret, sess.user.email, "Nokos.ID Admin");
    return json({
      ok: true,
      otpauth_uri: uri,
      secret, // ditampilkan sekali untuk input manual; tidak disimpan plaintext
      recovery_codes: recoveryCodes, // tampilkan sekali; simpan offline
      message: "Scan QR di aplikasi authenticator, lalu verifikasi kode di /api/auth/2fa/verify. Simpan recovery codes di tempat aman.",
    });
  },
);
