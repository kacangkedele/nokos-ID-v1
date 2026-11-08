// tests/security.test.js — uji hashing, TOTP, enkripsi
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, encryptSecret, decryptSecret, safeEqualHex, hmacSHA256 } from "../src/security.js";
import { generateTOTPSecret, generateTOTP, verifyTOTP, otpauthURI, generateRecoveryCodes } from "../src/totp.js";

describe("Password hashing", () => {
  it("hash password → verify benar", async () => {
    const hash = await hashPassword("MySecret123!@#");
    expect(hash).toMatch(/^\$pbkdf2-sha256\$/);
    expect(await verifyPassword("MySecret123!@#", hash)).toBe(true);
  });
  it("verify salah → false", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
  it("hash yang sama menghasilkan hash berbeda (salt acak)", async () => {
    const h1 = await hashPassword("samepass");
    const h2 = await hashPassword("samepass");
    expect(h1).not.toBe(h2);
    expect(await verifyPassword("samepass", h1)).toBe(true);
    expect(await verifyPassword("samepass", h2)).toBe(true);
  });
});

describe("AES-GCM encryption (TOTP secret)", () => {
  it("encrypt → decrypt kembali ke plaintext", async () => {
    const env = { ENCRYPTION_KEY: "test-key-32bytes-long-xxxxxxx" };
    const secret = "JBSWY3DPEHPK3PXP";
    const enc = await encryptSecret(secret, env);
    expect(enc.ct).not.toBe(secret);
    expect(enc.iv).toBeTruthy();
    const dec = await decryptSecret(enc, env);
    expect(dec).toBe(secret);
  });
  it("decrypt dengan kunci salah → throw", async () => {
    const enc = await encryptSecret("secret", { ENCRYPTION_KEY: "key-A-32bytes-long-xxxxxxxxxx" });
    await expect(decryptSecret(enc, { ENCRYPTION_KEY: "key-B-32bytes-long-xxxxxxxxxx" })).rejects.toThrow();
  });
});

describe("TOTP (RFC 6238)", () => {
  it("generate secret 20 byte base32", () => {
    const s = generateTOTPSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
  });
  it("verifyTOTP menerima kode yang benar", async () => {
    const s = generateTOTPSecret();
    const code = await generateTOTP(s);
    expect(await verifyTOTP(s, code)).toBe(true);
  });
  it("verifyTOTP menolak kode salah", async () => {
    const s = generateTOTPSecret();
    expect(await verifyTOTP(s, "000000")).toBe(false);
  });
  it("otpauth URI terformat benar", () => {
    const s = "JBSWY3DPEHPK3PXP";
    const uri = otpauthURI(s, "admin@nokos.id", "Nokos.ID Admin");
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
  });
  it("recovery codes format XXXX-XXXX-XXXX-XXXX", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes.length).toBe(10);
    codes.forEach((c) => expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/));
    // unik
    expect(new Set(codes).size).toBe(10);
  });
});

describe("HMAC webhook signature", () => {
  it("hmacSHA256 deterministik", async () => {
    const a = await hmacSHA256("secret", "message");
    const b = await hmacSHA256("secret", "message");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
  it("safeEqualHex constant-time", () => {
    const a = "a".repeat(64);
    const b = "a".repeat(64);
    expect(safeEqualHex(a, b)).toBe(true);
    expect(safeEqualHex(a, "b".repeat(64))).toBe(false);
    expect(safeEqualHex(a, "short")).toBe(false);
  });
});
