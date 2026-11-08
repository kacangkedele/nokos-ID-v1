// tests/wallet-ledger.test.js — uji jalur uang kritis
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockDB, createMockEnv } from "./helpers/mock-db.js";
import { ensureWallet, postTransaction, getWalletSummary, reconcileWallet } from "../src/wallet-ledger.js";
import { hashPassword } from "../src/security.js";
import { now } from "../src/utils.js";

let db, env;

async function seedUser(username = "testuser", role = "user") {
  const t = now();
  const hash = await hashPassword("TestPassword!2026");
  const res = await db.prepare(
    `INSERT INTO users (username, email, password_hash, role, status, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
  ).bind(username, `${username}@test.com`, hash, role, t, t).run();
  const userId = res.meta.last_row_id;
  await ensureWallet(db, userId);
  return userId;
}

beforeEach(async () => {
  db = createMockDB();
  env = createMockEnv(db);
});

afterEach(() => db._close());

describe("Wallet Ledger — atomic transaction", () => {
  it("postTransaction kredit menambah saldo + mencatat ledger", async () => {
    const userId = await seedUser();
    const res = await postTransaction(db, {
      userId, referenceId: "test-dep-1", transactionType: "deposit",
      amount: 50000, idempotencyKey: "dep-1",
      description: "test deposit",
    });
    expect(res.balance_before).toBe(0);
    expect(res.balance_after).toBe(50000);
    expect(res.ledger_id).toBeTruthy();

    const summary = await getWalletSummary(db, userId);
    expect(summary.balance).toBe(50000);
    expect(summary.total_deposit).toBe(50000);
  });

  it("postTransaction debit mengurangi saldo", async () => {
    const userId = await seedUser();
    await postTransaction(db, { userId, referenceId: "d1", transactionType: "deposit", amount: 100000, idempotencyKey: "d1" });
    const res = await postTransaction(db, { userId, referenceId: "o1", transactionType: "order", amount: -30000, idempotencyKey: "o1" });
    expect(res.balance_after).toBe(70000);
    const summary = await getWalletSummary(db, userId);
    expect(summary.balance).toBe(70000);
    expect(summary.total_order).toBe(30000);
  });

  it("menolak transaksi bila saldo tidak cukup (saldo minus dicegah)", async () => {
    const userId = await seedUser();
    await expect(
      postTransaction(db, { userId, referenceId: "o1", transactionType: "order", amount: -50000, idempotencyKey: "o1" }),
    ).rejects.toThrow();
    // saldo tetap 0
    const summary = await getWalletSummary(db, userId);
    expect(summary.balance).toBe(0);
  });
});

describe("Wallet Ledger — idempotency (anti double-credit)", () => {
  it("idempotency_key sama → transaksi kedua return already_processed, saldo TIDAK ganda", async () => {
    const userId = await seedUser();
    const key = "dep-idem-1";
    const r1 = await postTransaction(db, { userId, referenceId: "dep1", transactionType: "deposit", amount: 50000, idempotencyKey: key });
    expect(r1.balance_after).toBe(50000);
    // coba lagi dengan key sama
    const r2 = await postTransaction(db, { userId, referenceId: "dep1", transactionType: "deposit", amount: 50000, idempotencyKey: key });
    expect(r2.already_processed).toBe(true);
    // saldo tetap 50000, bukan 100000
    const summary = await getWalletSummary(db, userId);
    expect(summary.balance).toBe(50000);
  });
});

describe("Wallet Ledger — reconcile", () => {
  it("balance wallet konsisten dengan SUM ledger", async () => {
    const userId = await seedUser();
    await postTransaction(db, { userId, referenceId: "d1", transactionType: "deposit", amount: 100000, idempotencyKey: "d1" });
    await postTransaction(db, { userId, referenceId: "o1", transactionType: "order", amount: -30000, idempotencyKey: "o1" });
    await postTransaction(db, { userId, referenceId: "r1", transactionType: "refund", amount: 10000, idempotencyKey: "r1" });
    const recon = await reconcileWallet(db, userId);
    expect(recon.wallet_balance).toBe(80000);
    expect(recon.ledger_balance).toBe(80000);
    expect(recon.consistent).toBe(true);
  });
});
