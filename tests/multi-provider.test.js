// tests/multi-provider.test.js — uji multi-provider OTP management
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockDB, createMockEnv } from "./helpers/mock-db.js";
import { getAdapter, getProviderConfig, listActiveProviders, supportedProviders } from "../src/providers/registry.js";
import { resolveProvider, computeSellPrice } from "../src/routing.js";
import { createProvider, updateProvider, deleteProvider, testConnection, providerStats } from "../src/provider-manager.js";
import { createOrder, confirmOrder, refundOrder } from "../src/otp.js";
import { ensureWallet, postTransaction, getWalletSummary } from "../src/wallet-ledger.js";
import { hashPassword } from "../src/security.js";
import { now } from "../src/utils.js";
import { BaseAdapter, UnsupportedError } from "../src/providers/base.js";

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
  if (role !== "user") {
    await db.prepare(
      `INSERT INTO admin_users (user_id, role, two_factor_enabled, two_factor_secret_enc, two_factor_iv, created_at)
       VALUES (?, ?, 1, 'enc', 'iv', ?)`,
    ).bind(uid, role, t).run();
  }
  return uid;
}

/** Test adapter yang berfungsi penuh untuk uji routing tanpa provider eksternal. */
class MockAdapter extends BaseAdapter {
  constructor(config, env, opts = {}) {
    super(config, env);
    this.priceResponse = opts.priceResponse ?? [{ id: "wa", name: "WhatsApp", price: 5000 }];
    this.purchaseResult = opts.purchaseResult ?? { provider_order_id: "mock-" + Math.random().toString(36).slice(2), phone_number: "62" + Math.floor(Math.random() * 1e9) };
    this.statusResponse = opts.statusResponse ?? { sms: "123456", status: "completed" };
  }
  async getCountries() { return [{ id: "ID", name: "Indonesia" }]; }
  async getServices() { return [{ id: "wa", name: "WhatsApp" }]; }
  async getPrices(country, service) { return this.priceResponse; }
  async getAvailability(country, service) { return { available: true }; }
  async purchaseNumber({ country, service, operator }, otpOrderId) { return this.purchaseResult; }
  async getOrderStatus() { return this.statusResponse; }
  async cancelOrder() { return { cancelled: true, refund_eligible: true }; }
  async getBalance() { return 100000; }
  async testConnection() { return { ok: true, sample: [{ id: "ID" }] }; }
}

// MockAdapter dipakai untuk verifikasi kontrak base adapter (lihat test suite terakhir).
import { BaseAdapter, UnsupportedError } from "../src/providers/base.js";

beforeEach(async () => {
  db = createMockDB();
  env = createMockEnv(db);
});

afterEach(() => db._close());

describe("Multi-Provider — registry & adapter selection", () => {
  it("supportedProviders mengembalikan ruangotp & kirimkode", () => {
    const codes = supportedProviders();
    expect(codes).toContain("ruangotp");
    expect(codes).toContain("kirimkode");
  });

  it("getAdapter melempar bila provider inactive (tanpa force)", async () => {
    // provider ruangotp default seed = inactive
    await expect(getAdapter(env, "ruangotp")).rejects.toThrow(/inactive/);
  });

  it("getAdapter dengan force=true bypass status check (untuk admin test)", async () => {
    const adapter = await getAdapter(env, "ruangotp", { force: true });
    expect(adapter.code).toBe("ruangotp");
  });

  it("getAdapter melempar bila provider_code tidak ada di registry", async () => {
    // buat provider dengan code yang tidak terdaftar adapter-nya
    await createProvider(db, {
      provider_code: "ruangotp", // sudah ada di seed, skip
      provider_name: "Test",
      base_url: "https://x.test/api",
      api_key_secret_name: "X_API_KEY",
    }, 1).catch(() => {}); // ignore duplicate
    await expect(getAdapter(env, "nonexistent")).rejects.toThrow(/tidak ditemukan/);
  });

  it("getProviderConfig parse configuration JSON", async () => {
    const cfg = await getProviderConfig(db, "ruangotp");
    expect(cfg.configuration.paths).toBeTruthy();
    expect(cfg.configuration.paths.countries).toBe("/country-v2/list");
  });
});

describe("Multi-Provider — routing", () => {
  it("computeSellPrice menambahkan markup", () => {
    expect(computeSellPrice(10000, 15)).toBe(11500);
    expect(computeSellPrice(0, 15)).toBe(0);
  });

  it("routing priority memilih provider aktif priority terendah", async () => {
    // set last_test_ok dulu, baru bisa aktifkan
    await db.prepare(`UPDATE providers SET last_test_ok = 1 WHERE id = 1`).bind().run();
    await updateProvider(db, 1, { status: "active" }, 1);
    const active = await listActiveProviders(db);
    expect(active.length).toBeGreaterThan(0);
    expect(active[0].provider_code).toBe("ruangotp");
  });

  it("routing melempar bila tidak ada provider aktif", async () => {
    await expect(resolveProvider(env, { mode: "priority", country: "ID", service: "wa" }))
      .rejects.toThrow(/tidak ada provider aktif|No active provider/i);
  });

  it("routing manual melempar bila provider_code tidak aktif", async () => {
    await expect(resolveProvider(env, { mode: "manual", provider_code: "ruangotp", country: "ID", service: "wa" }))
      .rejects.toThrow();
  });
});

describe("Multi-Provider — provider manager CRUD", () => {
  it("createProvider: status selalu inactive, validasi code", async () => {
    const p = await createProvider(db, {
      provider_code: "testprov",
      provider_name: "Test Provider",
      base_url: "https://api.test.com",
      api_key_secret_name: "TESTPROV_API_KEY",
      markup_percent: 20,
      priority: 5,
    }, 1);
    expect(p.status).toBe("inactive");
    expect(p.id).toBeTruthy();
  });

  it("createProvider menolak code tidak valid", async () => {
    await expect(createProvider(db, {
      provider_code: "BAD CODE!",
      provider_name: "X",
      base_url: "https://x.test",
      api_key_secret_name: "X_API",
    }, 1)).rejects.toThrow();
  });

  it("updateProvider menolak set active bila belum test_ok", async () => {
    await expect(updateProvider(db, 1, { status: "active" }, 1)).rejects.toThrow(/test koneksi/i);
  });

  it("updateProvider set active setelah last_test_ok=1", async () => {
    await db.prepare(`UPDATE providers SET last_test_ok = 1 WHERE id = 1`).bind().run();
    const p = await updateProvider(db, 1, { status: "active" }, 1);
    expect(p.status).toBe("active");
  });

  it("deleteProvider menolak bila status != disabled", async () => {
    await expect(deleteProvider(db, 1, 1)).rejects.toThrow(/disabled/i);
  });

  it("deleteProvider menolak bila ada order terkait", async () => {
    await db.prepare(`UPDATE providers SET last_test_ok = 1, status = 'disabled' WHERE id = 1`).bind().run();
    // buat order terkait provider 1
    const userId = await seedUser("u_del");
    await db.prepare(`INSERT INTO otp_orders (id, user_id, idempotency_key, country_id, service_id, provider_id, cost_cents, status, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'pending', ?, ?, ?)`)
      .bind("del-order-1", userId, "idem-del", "ID", "wa", 1, 5000, now() + 900, now(), now()).run();
    await expect(deleteProvider(db, 1, 1)).rejects.toThrow(/order terkait/i);
  });

  it("providerStats return totals + per_provider", async () => {
    const stats = await providerStats(db);
    expect(stats.totals.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(stats.per_provider)).toBe(true);
    expect(stats.per_provider.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Multi-Provider — order with provider_id", () => {
  it("createOrder menerima provider_id & menyimpannya", async () => {
    const userId = await seedUser("u_order");
    const order = await createOrder(db, userId, {
      country_id: "ID", service_id: "wa", provider_id: 1, provider_cost_cents: 5000,
    }, { price_markup_percent: 15 });
    expect(order.provider_id).toBe(1);
    // cost_cents = 5000 + 15% markup = 5750
    expect(order.cost_cents).toBe(5750);
  });

  it("confirmOrder backfills provider_id bila NULL (legacy)", async () => {
    // active-kan provider default
    await db.prepare(`UPDATE providers SET last_test_ok = 1, status = 'active' WHERE id = 1`).bind().run();
    const userId = await seedUser("u_legacy");
    // kasih saldo
    await postTransaction(db, { userId, referenceId: "dep1", transactionType: "deposit", amount: 100000, idempotencyKey: "dep-legacy" });

    // buat order TANPA provider_id
    const order = await createOrder(db, userId, {
      country_id: "ID", service_id: "wa", provider_cost_cents: 5000,
    }, { price_markup_percent: 15 });
    // confirmOrder harus fallback ke default provider — akan panggil adapter asli
    // yang butuh API key. Karena API key tidak ada di test, akan throw & refund.
    const result = await confirmOrder(db, env, order.id, userId);
    // hasil: failed (provider tidak bisa dipanggil) — saldo direfund
    expect(result.status).toBe("failed");
    // saldo kembali ke 100000 (refund)
    const summary = await getWalletSummary(db, userId);
    expect(summary.balance).toBe(100000);
  });
});

describe("Multi-Provider — double purchase prevention", () => {
  it("confirmOrder kedua pada order yang sama → already_processed", async () => {
    await db.prepare(`UPDATE providers SET last_test_ok = 1, status = 'active' WHERE id = 1`).bind().run();
    const userId = await seedUser("u_double");
    await postTransaction(db, { userId, referenceId: "dep2", transactionType: "deposit", amount: 100000, idempotencyKey: "dep-double" });
    const order = await createOrder(db, userId, {
      country_id: "ID", service_id: "wa", provider_cost_cents: 5000,
    }, { price_markup_percent: 15 });
    const r1 = await confirmOrder(db, env, order.id, userId);
    const r2 = await confirmOrder(db, env, order.id, userId);
    expect(r2.already_processed).toBe(true);
  });

  it("refundOrder idempotent — tidak refund dua kali", async () => {
    const userId = await seedUser("u_refund2");
    await postTransaction(db, { userId, referenceId: "dep3", transactionType: "deposit", amount: 100000, idempotencyKey: "dep-r2" });
    const order = await createOrder(db, userId, {
      country_id: "ID", service_id: "wa", provider_cost_cents: 5000,
    }, { price_markup_percent: 15 });
    const orderRow = await db.prepare(`SELECT * FROM otp_orders WHERE id = ?`).bind(order.id).first();
    // potong manual (simulasi)
    await postTransaction(db, { userId, referenceId: order.id, transactionType: "order", amount: -order.cost_cents, idempotencyKey: `order:${order.id}` });
    const r1 = await refundOrder(db, orderRow, "test refund 1");
    const r2 = await refundOrder(db, orderRow, "test refund 2");
    expect(r1.refunded).toBe(true);
    expect(r2.already_refunded).toBe(true);
    // saldo hanya +1x refund
    const summary = await getWalletSummary(db, userId);
    expect(summary.balance).toBe(100000);
  });
});

describe("Multi-Provider — base adapter contract", () => {
  it("UnsupportedError dilempar untuk method tidak diimplementasi", async () => {
    class Bare extends BaseAdapter {
      constructor() { super({ id: 0, provider_code: "bare", provider_name: "Bare", markup_percent: 0, timeout_ms: 1000, max_retries: 0, configuration: {} }, {}); }
    }
    const a = new Bare();
    // async method → reject dengan UnsupportedError
    await expect(a.getCountries()).rejects.toThrow(UnsupportedError);
    await expect(a.getBalance()).rejects.toThrow(UnsupportedError);
  });

  it("parseSmsActivateString mengenali format umum", async () => {
    const { parseSmsActivateString } = await import("../src/providers/base.js");
    expect(parseSmsActivateString("ACCESS_NUMBER:abc123:62812")).toEqual({ ok: true, providerOrderId: "abc123", number: "62812" });
    expect(parseSmsActivateString("NO_NUMBERS")).toEqual({ ok: false, reason: "NO_NUMBERS" });
    expect(parseSmsActivateString("STATUS_OK:123456")).toEqual({ ok: true, sms: "123456" });
    expect(parseSmsActivateString("STATUS_CANCEL")).toEqual({ ok: true, cancelled: true });
    expect(parseSmsActivateString("garbage")).toBeNull();
  });
});
