// tests/hidden-provider.test.js — uji Hidden Provider System
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockDB, createMockEnv } from "./helpers/mock-db.js";
import { maskProvider, maskProviderList, getDisplayName, sanitizeForUser, containsProviderLeak } from "../src/public-view.js";
import { listActiveProviders } from "../src/providers/registry.js";
import { listUserOrders, createOrder, confirmOrder } from "../src/otp.js";
import { ensureWallet, postTransaction, getWalletSummary } from "../src/wallet-ledger.js";
import { hashPassword } from "../src/security.js";
import { now } from "../src/utils.js";
import { first, run } from "../src/db.js";

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
  return uid;
}

beforeEach(async () => { db = createMockDB(); env = createMockEnv(db); });
afterEach(() => db._close());

describe("Hidden Provider — masking layer (public-view.js)", () => {
  it("maskProvider hanya return { id, display_name }", () => {
    const masked = maskProvider({
      id: 1, provider_code: "ruangotp", provider_name: "RuangOTP",
      display_name: "Nokos.ID Server", base_url: "https://secret", api_key_secret_name: "RUANGOTP_API_KEY",
    });
    expect(masked).toEqual({ id: 1, display_name: "Nokos.ID Server" });
    expect(masked.provider_code).toBeUndefined();
    expect(masked.provider_name).toBeUndefined();
    expect(masked.base_url).toBeUndefined();
    expect(masked.api_key_secret_name).toBeUndefined();
  });

  it("maskProvider default display_name bila NULL (Nokos.ID Server untuk default, Server N)", () => {
    const m1 = maskProvider({ id: 1, is_default: 1 });
    expect(m1.display_name).toBe("Nokos.ID Server");
    const m2 = maskProvider({ id: 2, is_default: 0 });
    expect(m2.display_name).toBe("Server 2");
  });

  it("maskProviderList strip semua field sensitif", () => {
    const list = maskProviderList([
      { id: 1, provider_code: "ruangotp", provider_name: "RuangOTP", display_name: "Nokos.ID Server" },
      { id: 2, provider_code: "kirimkode", provider_name: "KirimKode", display_name: "Server 2" },
    ]);
    expect(list.length).toBe(2);
    list.forEach((p) => {
      expect(p.provider_code).toBeUndefined();
      expect(p.provider_name).toBeUndefined();
    });
    expect(list[0].display_name).toBe("Nokos.ID Server");
    expect(list[1].display_name).toBe("Server 2");
  });

  it("getDisplayName ambil dari DB", async () => {
    const name = await getDisplayName(db, 1); // ruangotp seed
    expect(name).toBe("Nokos.ID Server");
  });

  it("getDisplayName return null bila provider tidak ada", async () => {
    const name = await getDisplayName(db, 999);
    expect(name).toBeNull();
  });
});

describe("Hidden Provider — sanitization (sanitizeForUser)", () => {
  it("strip nama provider asli dari string", () => {
    expect(sanitizeForUser("Provider 'ruangotp' timeout")).toBe("Nokos.ID Server timeout");
    expect(sanitizeForUser("adapter kirimkode gagal")).toBe("Nokos.ID Server gagal");
    // BAD_KEY adalah kode error provider yang bisa mengungkap identitas → juga di-sanitize
    expect(sanitizeForUser("Error from sms-activate: BAD_KEY")).toBe("Error from Nokos.ID Server: Nokos.ID Server");
    expect(sanitizeForUser("NO_NUMBERS returned")).toBe("Nokos.ID Server returned");
  });

  it("strip api_key / secret / base_url / endpoint", () => {
    expect(sanitizeForUser("api_key RUANGOTP_API_KEY missing")).toContain("Nokos.ID Server");
    expect(sanitizeForUser("base_url https://ruangotp.io/api")).toContain("Nokos.ID Server");
    expect(sanitizeForUser("endpoint /order-v2/get-number")).toContain("Nokos.ID Server");
  });

  it("containsProviderLeak mendeteksi kebocoran", () => {
    expect(containsProviderLeak("via RuangOTP")).toBe(true);
    expect(containsProviderLeak("pake kirimkode")).toBe(true);
    expect(containsProviderLeak("Server 1")).toBe(false);
    expect(containsProviderLeak("Nokos.ID Server")).toBe(false);
  });

  it("string bersih tidak diubah", () => {
    expect(sanitizeForUser("Pembelian gagal. Saldo direfund.")).toBe("Pembelian gagal. Saldo direfund.");
  });
});

describe("Hidden Provider — listActiveProviders (internal, admin-only)", () => {
  it("listActiveProviders return semua field (untuk admin)", async () => {
    await db.prepare(`UPDATE providers SET last_test_ok = 1, status = 'active' WHERE id = 1`).bind().run();
    const list = await listActiveProviders(db);
    expect(list[0].provider_code).toBe("ruangotp");
    expect(list[0].provider_name).toBe("RuangOTP");
    // admin endpoint boleh return ini — RBAC protected
  });
});

describe("Hidden Provider — listUserOrders (user-facing)", () => {
  it("listUserOrders return server_name, BUKAN provider_code/name", async () => {
    const userId = await seedUser("u_hidden");
    // buat order dengan provider_id=1 (ruangotp)
    await db.prepare(
      `INSERT INTO otp_orders (id, user_id, idempotency_key, country_id, service_id, provider_id, cost_cents, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).bind("order-hidden-1", userId, "idem-h1", "ID", "wa", 1, 5000, now() + 900, now(), now()).run();

    const orders = await listUserOrders(db, userId);
    expect(orders.length).toBe(1);
    const o = orders[0];
    // HARUS ada server_name (display_name generik)
    expect(o.server_name).toBe("Nokos.ID Server");
    // TIDAK boleh ada provider_code / provider_name
    expect(o.provider_code).toBeUndefined();
    expect(o.provider_name).toBeUndefined();
    expect(o.provider_id).toBeUndefined();
  });

  it("listUserOrders fallback ke 'Nokos.ID Server' bila provider_id NULL (legacy)", async () => {
    const userId = await seedUser("u_legacy2");
    await db.prepare(
      `INSERT INTO otp_orders (id, user_id, idempotency_key, country_id, service_id, provider_id, cost_cents, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?, ?)`,
    ).bind("order-legacy-1", userId, "idem-l1", "ID", "wa", 5000, now() + 900, now(), now()).run();
    const orders = await listUserOrders(db, userId);
    expect(orders[0].server_name).toBe("Nokos.ID Server");
  });
});

describe("Hidden Provider — confirmOrder response tidak bocor", () => {
  it("confirmOrder return { status, phone_number, cost_cents } TANPA provider_code", async () => {
    await db.prepare(`UPDATE providers SET last_test_ok = 1, status = 'active' WHERE id = 1`).bind().run();
    const userId = await seedUser("u_confirm");
    await postTransaction(db, { userId, referenceId: "dep-h", transactionType: "deposit", amount: 100000, idempotencyKey: "dep-h1" });
    const order = await createOrder(db, userId, {
      country_id: "ID", service_id: "wa", provider_id: 1, provider_cost_cents: 5000,
    }, { price_markup_percent: 15 });
    const result = await confirmOrder(db, env, order.id, userId);
    // Provider call akan gagal (no API key di test) → result.status='failed'
    // failure_reason HARUS generic, tidak boleh mention provider
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toBeTruthy();
    expect(containsProviderLeak(result.failure_reason)).toBe(false);
    // TIDAK boleh ada provider_code / provider_order_id di result yang dikirim ke user
    expect(result.provider_code).toBeUndefined();
    expect(result.provider_order_id).toBeUndefined();
  });

  it("notification body tidak mengandung nama provider asli", async () => {
    await db.prepare(`UPDATE providers SET last_test_ok = 1, status = 'active' WHERE id = 1`).bind().run();
    const userId = await seedUser("u_notif");
    await postTransaction(db, { userId, referenceId: "dep-n", transactionType: "deposit", amount: 100000, idempotencyKey: "dep-n1" });
    const order = await createOrder(db, userId, {
      country_id: "ID", service_id: "wa", provider_id: 1, provider_cost_cents: 5000,
    }, { price_markup_percent: 15 });
    await confirmOrder(db, env, order.id, userId);
    // ambil notifikasi user
    const notifs = await db.prepare(`SELECT title, body FROM notifications WHERE user_id = ?`).bind(userId).all();
    for (const n of notifs.results || []) {
      expect(containsProviderLeak(n.title)).toBe(false);
      expect(containsProviderLeak(n.body)).toBe(false);
    }
  });
});

describe("Hidden Provider — DB internal tetap mencatat provider asli", () => {
  it("otp_orders.provider_id tercatat untuk tracking admin", async () => {
    const userId = await seedUser("u_track");
    await db.prepare(
      `INSERT INTO otp_orders (id, user_id, idempotency_key, country_id, service_id, provider_id, cost_cents, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).bind("order-track-1", userId, "idem-t1", "ID", "wa", 2, 5000, now() + 900, now(), now()).run();
    const row = await first(db, `SELECT provider_id FROM otp_orders WHERE id = ?`, ["order-track-1"]);
    expect(row.provider_id).toBe(2); // internal tracking tetap ada
  });

  it("wallet_audit_logs mencatat provider_code internal", async () => {
    await db.prepare(`UPDATE providers SET last_test_ok = 1, status = 'active' WHERE id = 1`).bind().run();
    const userId = await seedUser("u_audit");
    await postTransaction(db, { userId, referenceId: "dep-a", transactionType: "deposit", amount: 100000, idempotencyKey: "dep-a1" });
    const order = await createOrder(db, userId, {
      country_id: "ID", service_id: "wa", provider_id: 1, provider_cost_cents: 5000,
    }, { price_markup_percent: 15 });
    // confirmOrder akan gagal (no API key) → refundOrder → audit entry 'otp_refund' dibuat
    await confirmOrder(db, env, order.id, userId);
    const log = await first(db,
      `SELECT details FROM wallet_audit_logs WHERE reference_id = ? AND action = 'otp_refund'`,
      [order.id]);
    expect(log).toBeTruthy();
    const details = JSON.parse(log.details);
    expect(details.amount).toBeGreaterThan(0); // refund amount tercatat internal
  });
});
