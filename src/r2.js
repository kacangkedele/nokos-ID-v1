// src/r2.js — upload & akses bukti pembayaran di Cloudflare R2
//
// Bucket harus PRIVATE (tidak public-read). Akses hanya via signed URL
// yang dihasilkan backend untuk admin melihat bukti.
//
// Nama file: random UUID + ekstensi asal. Tidak pakai nama asli pengguna
// (cegah path traversal + bocor identitas).
//
// Cloudflare R2 binding di-expose sebagai object store; signed URL dibuat
// via R2 S3-compatible API bila tersedia, atau via proxy endpoint
// /api/admin/deposits/:id/proof yang stream dari R2 (pilihan default).

import { randomHex } from "./utils.js";

const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Upload file bukti ke R2. Kembalikan object key.
 * @param {R2Bucket} bucket - binding BUKTI
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} mime
 * @param {object} meta - { userId, depositId }
 */
export async function uploadProof(bucket, bytes, mime, meta) {
  if (!bucket) throw new Error("R2 binding 'BUKTI' tidak tersedia");
  const ext = EXT_BY_MIME[mime] || "bin";
  const key = `proofs/${meta.userId}/${meta.depositId}-${randomHex(8)}.${ext}`;
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: {
      uploadedBy: String(meta.userId),
      depositId: String(meta.depositId),
      uploadedAt: String(Math.floor(Date.now() / 1000)),
    },
  });
  return { key, mime };
}

/**
 * Stream object R2 sebagai response (untuk proxy endpoint admin).
 * @param {R2Bucket} bucket
 * @param {string} key
 * @param {number} maxAgeSeconds - cache TTL untuk signed access
 */
export async function streamObject(bucket, key, maxAgeSeconds = 3600) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", `private, max-age=${maxAgeSeconds}`);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", `inline; filename="bukti-${Date.now()}.bin"`);
  return new Response(obj.body, { status: 200, headers });
}

/**
 * Hapus object R2 (untuk retensi/cleanup 90 hari).
 */
export async function deleteObject(bucket, key) {
  if (!bucket) return false;
  await bucket.delete(key);
  return true;
}
