#!/usr/bin/env node
// scripts/create-admin-cli.js — versi non-interaktif dari create-admin.js
// untuk otomatisasi. Kompatibel dengan PBKDF2 format di src/security.js.
//
// Penggunaan:
//   node scripts/create-admin-cli.js <email> <password> [--local] [--role=super_admin]
//
// Contoh:
//   node scripts/create-admin-cli.js admin@nokos.id "AdminNokos2026!" --local
//   node scripts/create-admin-cli.js admin@nokos.id "AdminNokos2026!" --role=super_admin
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

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Penggunaan: node scripts/create-admin-cli.js <email> <password> [--local] [--role=super_admin] [--username=superadmin]");
    process.exit(1);
  }
  const email = args[0].trim().toLowerCase();
  const password = args[1].trim();
  const useLocal = args.includes("--local");
  const roleArg = args.find((a) => a.startsWith("--role="));
  const role = roleArg ? roleArg.split("=")[1] : "super_admin";
  const usernameArg = args.find((a) => a.startsWith("--username="));
  const username = usernameArg ? usernameArg.split("=")[1] : email.split("@")[0];

  if (password.length < 10) {
    console.error("Password minimal 10 karakter.");
    process.exit(1);
  }
  const validRoles = ["super_admin", "admin_deposit", "admin_support", "admin_ops"];
  if (!validRoles.includes(role)) {
    console.error("Role tidak valid. Pilih:", validRoles.join(", "));
    process.exit(1);
  }

  console.log(`Hashing password untuk ${email} (role: ${role})...`);
  const hash = await hashPassword(password);
  console.log("Hash:", hash.slice(0, 50) + "...");

  const t = Math.floor(Date.now() / 1000);
  const flag = useLocal ? "--local" : "";
  const sqlUpsert = `INSERT INTO users (username, email, password_hash, role, status, email_verified, created_at, updated_at)
VALUES ('${username}', '${email}', '${hash.replace(/'/g, "''")}', '${role}', 'active', 1, ${t}, ${t})
ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role, status='active', email_verified=1, updated_at=excluded.updated_at;`;

  const sqlAdmin = `INSERT INTO admin_users (user_id, role, created_at)
SELECT id, '${role}', ${t} FROM users WHERE email='${email}'
ON CONFLICT(user_id) DO UPDATE SET role=excluded.role;`;

  const sqlWallet = `INSERT INTO wallets (user_id, balance, currency, created_at, updated_at)
SELECT id, 0, 'IDR', ${t}, ${t} FROM users WHERE email='${email}'
ON CONFLICT(user_id) DO NOTHING;`;

  console.log("\nMenjalankan upsert ke D1" + (useLocal ? " (local)" : "") + "...");
  // PENTING: tulis SQL ke file lalu jalankan dengan --file.
  // Hash PBKDF2 mengandung '$' yang akan diinterpretasi bash sebagai variabel
  // jika dilewatkan via --command dalam double-quote, merusak hash.
  const tmpDir = mkdtempSync(join(tmpdir(), "nokos-admin-"));
  const tmpFile = join(tmpDir, "upsert.sql");
  writeFileSync(tmpFile, sqlUpsert + "\n" + sqlAdmin + "\n" + sqlWallet + "\n");
  try {
    execSync(`npx wrangler d1 execute nokos-db ${flag} --file "${tmpFile}"`, { stdio: "inherit" });
    console.log(`\n✓ Admin dibuat: ${username} (${email}) sebagai ${role}`);
    console.log("⚠ WAJIB: login ke /admin/2fa-setup.html untuk mengaktifkan 2FA sebelum operasi admin!");
  } catch (e) {
    console.error("Gagal:", e.message);
    process.exit(1);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(tmpFile); } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
