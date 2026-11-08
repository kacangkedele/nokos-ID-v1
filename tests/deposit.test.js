// tests/deposit.test.js — uji approve/reject deposit QRIS manual
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockDB, createMockEnv } from "./helpers/mock-db.js";
import { ensureWallet, postTransaction, getWalletSummary } from "../src/wallet-ledger.js";
import { createDeposit, attachProof, approveDeposit, rejectDeposit, cancelDeposit } from "../src/deposit.js";
import { hashPassword } from "../src/security.js";
import { now, randomHex } from "../src/utils.js";

let db, env;

async function seedUser(username, role = "user") {
  const t = now();
  const hash = await hashPassword("TestPassword!2026");
  const res = await db.prepare(
    `INSERT INTO users (username, email, password_hash, role, status, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
  ).bind(username, `${username}@test.com`, hash, role, t, t).run();
  const uid = res.meta.last_row_id;
  await ensureWallet(db, uid);
  // bila admin, buat admin_users row dengan 2FA enabled
  if (role !== "user") {
    await db.prepare(
      `INSERT INTO admin_users (user_id, role, two_factor_enabled, two_factor_secret_enc, two_factor_iv, created_at)
       VALUES (?, ?, 1, 'enc', 'iv', ?)`,
    ).bind(uid, role, t).run();
  }
  return uid;
}

beforeEach(() => { db = createMockDB(); env = createMockEnv(db); });
afterEach(() => db._close());

describe("Deposit QRIS Manual — alur lengkap", () => {
  it("createDeposit → attachProof → approve: saldo bertambah SATU kali", async () => {
    const userId = await seedUser("user1");
    const adminId = await seedUser("admin1", "super_admin");
    const adminUser = { id: adminId, role: "super_admin", username: "admin1" };
    const settings = { qris_merchant_name: "Angga Official" };

    const dep = await createDeposit(db, userId, 100000, settings);
    expect(dep.amount).toBe(100000);
    expect(dep.merchant_name).toBe("Angga Official");

    // simulasikan upload bukti
    const fakeFile = { arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer };
    await attachProof(db, env, dep.id, userId, fakeFile, "image/jpeg");

    // approve
    const result = await approveDeposit(db, env, dep.id, adminUser);
    expect(result.status).toBe("approved");
    expect(result.amount).toBe(100000);

    // saldo user bertambah
    const summary = await getWalletSummary(db, userId);
    expect(summary.balance).toBe(100000);
    expect(summary.total_deposit).toBe(100000);
  });

  it("approve kedua kali dengan id deposit sama → already_approved, saldo TIDAK ganda", async () => {
    const userId = await seedUser("user2");
    const adminId = await seedUser("admin2", "admin_deposit");
    const adminUser = { id: adminId, role: "admin_deposit" };
    const dep = await createDeposit(db, userId, 50000, {});
    const fakeFile = { arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer };
    await attachProof(db, env, dep.id, userId, fakeFile, "image/png");

    const r1 = await approveDeposit(db, env, dep.id, adminUser);
    expect(r1.status).toBe("approved");

    const r2 = await approveDeposit(db, env, dep.id, adminUser);
    expect(r2.already_approved).toBe(true);

    // saldo tetap 50000
    const summary = await getWalletSummary(db, userId);
    expect(summary.balance).toBe(50000);
  });

  it("rejectDeposit: saldo TIDAK berubah, alasan tersimpan", async () => {
    const userId = await seedUser("user3");
    const adminId = await seedUser("admin3", "super_admin");
    const adminUser = { id: adminId, role: "super_admin" };
    const dep = await createDeposit(db, userId, 75000, {});
    const fakeFile = { arrayBuffer: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0,0,0,0, 0x57, 0x45, 0x42, 0x50]).buffer };
    await attachProof(db, env, dep.id, userId, fakeFile, "image/webp");

    const r = await rejectDeposit(db, env, dep.id, adminUser, "Bukti tidak jelas");
    expect(r.status).toBe("rejected");
    expect(r.reason).toBe("Bukti tidak jelas");

    const summary = await getWalletSummary(db, userId);
    expect(summary.balance).toBe(0);
  });

  it("cancelDeposit: status cancelled, saldo tidak berubah", async () => {
    const userId = await seedUser("user4");
    const dep = await createDeposit(db, userId, 25000, {});
    const r = await cancelDeposit(db, dep.id, userId);
    expect(r.status).toBe("cancelled");
    const summary = await getWalletSummary(db, userId);
    expect(summary.balance).toBe(0);
  });

  it("IDOR guard: user lain tidak bisa attachProof ke deposit milik user lain", async () => {
    const userA = await seedUser("userA");
    const userB = await seedUser("userB");
    const dep = await createDeposit(db, userA, 50000, {});
    const fakeFile = { arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer };
    await expect(attachProof(db, env, dep.id, userB, fakeFile, "image/jpeg")).rejects.toThrow("Akses ditolak");
  });
});

describe("Deposit — RBAC", () => {
  it("admin_support TIDAK boleh approve deposit", async () => {
    const userId = await seedUser("user5");
    const adminId = await seedUser("admin4", "admin_support");
    const adminUser = { id: adminId, role: "admin_support" };
    const dep = await createDeposit(db, userId, 50000, {});
    await expect(approveDeposit(db, env, dep.id, adminUser)).rejects.toThrow("tidak punya hak");
  });

  it("admin tanpa 2FA tidak boleh approve", async () => {
    const userId = await seedUser("user6");
    const t = now();
    const hash = await hashPassword("TestPassword!2026");
    const res = await db.prepare(
      `INSERT INTO users (username, email, password_hash, role, status, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'admin_deposit', 'active', 1, ?, ?)`,
    ).bind("admin5", "admin5@test.com", hash, t, t).run();
    const adminId = res.meta.last_row_id;
    await db.prepare(
      `INSERT INTO admin_users (user_id, role, two_factor_enabled, created_at) VALUES (?, 'admin_deposit', 0, ?)`,
    ).bind(adminId, t).run();
    const adminUser = { id: adminId, role: "admin_deposit" };
    const dep = await createDeposit(db, userId, 50000, {});
    await expect(approveDeposit(db, env, dep.id, adminUser)).rejects.toThrow("2FA");
  });
});
