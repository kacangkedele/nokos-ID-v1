#!/usr/bin/env node
// scripts/create-admin.js — buat/perbarui admin via PBKDF2 hash + update D1.
//
// Penggunaan:
//   node scripts/create-admin.js
//
// Script meminta input interaktif (username, email, password, role),
// hash password dengan PBKDF2-SHA256 (210000 iterasi, kompatibel dengan
// format yang dibaca src/security.js), lalu menjalankan wrangler d1 execute.
//
// Catatan: butuh wrangler CLI terinstall dan sudah login.

import { createInterface } from "readline";
import { execSync } from "child_process";
import { webcrypto } from "crypto";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PBKDF2_ITER = 210000;
const SALT_BYTES = 16;
const KEYLEN = 32;

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

async function hashPassword(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  // PENTING: pakai deriveKey→HMAC→exportKey("raw") agar KOMPATIBEL dengan
  // verifyPassword di src/security.js. deriveBits langsung menghasilkan bytes berbeda.
  const baseKey = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"],
  );
  const key = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
    baseKey,
    { name: "HMAC", hash: "SHA-256", length: KEYLEN * 8 },
    true,
    ["sign"],
  );
  const hash = await webcrypto.subtle.exportKey("raw", key);
  return `$pbkdf2-sha256$${PBKDF2_ITER}$${b64(salt)}$${b64(new Uint8Array(hash))}`;
}

function ask(rl, q) {
  return new Promise((res) => rl.question(q, res));
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("=== Buat / Perbarui Admin Nokos.ID ===\n");
  const username = (await ask(rl, "Username: ")).trim();
  const email = (await ask(rl, "Email: ")).trim().toLowerCase();
  const password = (await ask(rl, "Password (min 10 char): ")).trim();
  if (password.length < 10) {
    console.error("Password minimal 10 karakter.");
    process.exit(1);
  }
  console.log("\nRole tersedia: super_admin, admin_deposit, admin_support, admin_ops");
  const role = (await ask(rl, "Role [super_admin]: ")).trim() || "super_admin";
  const validRoles = ["super_admin", "admin_deposit", "admin_support", "admin_ops"];
  if (!validRoles.includes(role)) {
    console.error("Role tidak valid:", role);
    process.exit(1);
  }
  const useLocal = (await ask(rl, "Gunakan D1 local? [y/N]: ")).trim().toLowerCase() === "y";

  rl.close();

  console.log("\nHashing password...");
  const hash = await hashPassword(password);
  console.log("Hash:", hash.slice(0, 40) + "...");

  // Upsert user
  const t = Math.floor(Date.now() / 1000);
  const flag = useLocal ? "--local" : "";
  const sqlUpsert = `INSERT INTO users (username, email, password_hash, role, status, email_verified, created_at, updated_at)
VALUES ('${username}', '${email}', '${hash.replace(/'/g, "''")}', '${role}', 'active', 1, ${t}, ${t})
ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role, updated_at=excluded.updated_at;`;

  const sqlAdmin = `INSERT INTO admin_users (user_id, role, created_at)
SELECT id, '${role}', ${t} FROM users WHERE email='${email}'
ON CONFLICT(user_id) DO UPDATE SET role=excluded.role;`;

  const sqlWallet = `INSERT INTO wallets (user_id, balance, currency, created_at, updated_at)
SELECT id, 0, 'IDR', ${t}, ${t} FROM users WHERE email='${email}'
ON CONFLICT(user_id) DO NOTHING;`;

  console.log("\nMenjalankan migration ke D1...");
  // PENTING: tulis SQL ke file lalu jalankan dengan --file.
  // Hash PBKDF2 mengandung '$' yang akan diinterpretasi bash sebagai variabel
  // jika dilewatkan via --command dalam double-quote, merusak hash.
  const tmpDir = mkdtempSync(join(tmpdir(), "nokos-admin-"));
  const tmpFile = join(tmpDir, "upsert.sql");
  writeFileSync(tmpFile, sqlUpsert + "\n" + sqlAdmin + "\n" + sqlWallet + "\n");
  try {
    execSync(`npx wrangler d1 execute nokos-db ${flag} --file "${tmpFile}"`, { stdio: "inherit" });
    console.log(`\n✓ Admin dibuat: ${username} (${email}) sebagai ${role}`);
    console.log("⚠ WAJIB: login ke /admin/2fa-setup.html untuk mengaktifkan 2FA sebelum verifikasi deposit!");
  } catch (e) {
    console.error("Gagal:", e.message);
    process.exit(1);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
