// functions/api/auth/register.js
import { withHandler, getClientIP, logSecurity } from "../../../src/middleware.js";
import { getDB, first, run } from "../../../src/db.js";
import { hashPassword } from "../../../src/security.js";
import { createSession, sessionCookies } from "../../../src/session.js";
import { validateRegister } from "../../../src/validation.js";
import { ensureWallet } from "../../../src/wallet-ledger.js";
import { json, now, normalizeEmail } from "../../../src/utils.js";

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
      clean = validateRegister(body);
    } catch (e) {
      return json({ error: e.message, field: e.field }, 422);
    }

    // cek duplikat username/email
    const dup = await first(
      db,
      `SELECT id FROM users WHERE username = ? OR email = ?`,
      [clean.username, clean.email],
    );
    if (dup) {
      // jangan ungkap field mana yang dipakai (account enumeration)
      await logSecurity(db, null, "register_duplicate", `username=${clean.username}`);
      return json({ error: "Username atau email sudah terdaftar." }, 409);
    }

    const t = now();
    const hash = await hashPassword(clean.password);
    const result = await run(
      db,
      `INSERT INTO users (username, email, password_hash, role, status, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'user', 'active', 0, ?, ?)`,
      [clean.username, clean.email, hash, t, t],
    );
    const userId = result.meta?.last_row_id;
    await ensureWallet(db, userId);

    // auto-login setelah register (opsional, tetapi UX baik)
    const newSess = await createSession(db, env.SESSIONS, { id: userId, username: clean.username, role: "user" }, {
      ip: getClientIP(request),
      ua: request.headers.get("User-Agent"),
      revokeOld: true,
    });

    return json(
      { ok: true, user: { id: userId, username: clean.username, email: clean.email }, csrf_token: newSess.csrf },
      201,
      { "Set-Cookie": sessionCookies(newSess, env).join(", ") },
    );
  },
);
