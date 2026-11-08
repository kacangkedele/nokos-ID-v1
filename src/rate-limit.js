// src/rate-limit.js — rate limiting via KV (sliding window counter)
//
// Key strategy: "rl:<bucket>:<id>". Setiap bucket menampung counter dalam
// window 60 detik. Instruksi:
//   - /api/auth/*  → 5 req/menit/IP
//   - /api/deposits → 5 req/menit/user
//   - /api/otp/orders → 10 req/menit/user
//   - /api/admin/deposits/:id/approve|reject → 30 req/menit/admin

const WINDOWS = {
  auth_ip: { limit: 5, ttl: 60 },
  deposit_user: { limit: 5, ttl: 60 },
  otp_user: { limit: 10, ttl: 60 },
  admin_action: { limit: 30, ttl: 60 },
  upload_proof: { limit: 5, ttl: 60 },
  password_reset: { limit: 3, ttl: 3600 },
};

/**
 * Cek dan increment counter rate-limit.
 * @returns {ok: boolean, remaining: number, reset: number}
 */
export async function rateLimit(kv, bucket, id) {
  if (!kv) return { ok: true, remaining: 9999, reset: 60, skipped: true };
  const cfg = WINDOWS[bucket] || { limit: 10, ttl: 60 };
  const key = `rl:${bucket}:${id}`;
  const now = Math.floor(Date.now() / 1000);
  const raw = await kv.get(key);
  let count = 0;
  let expiresAt = now + cfg.ttl;
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      if (obj.expiresAt > now) {
        count = obj.count || 0;
        expiresAt = obj.expiresAt;
      }
    } catch {
      count = 0;
    }
  }
  count += 1;
  if (count > cfg.limit) {
    return { ok: false, remaining: 0, reset: expiresAt - now };
  }
  await kv.put(key, JSON.stringify({ count, expiresAt }), { expirationTtl: cfg.ttl });
  return { ok: true, remaining: cfg.limit - count, reset: expiresAt - now };
}

/** Header standar rate-limit untuk respons. */
export function rateLimitHeaders(res) {
  return {
    "X-RateLimit-Limit": String(res.limit ?? 0),
    "X-RateLimit-Remaining": String(res.remaining),
    "X-RateLimit-Reset": String(res.reset),
  };
}
