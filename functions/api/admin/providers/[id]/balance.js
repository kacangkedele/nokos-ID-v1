// functions/api/admin/providers/[id]/balance.js
//   POST /api/admin/providers/:id/balance — ambil saldo provider (bila API dukung)
import { withHandler } from "../../../../../src/middleware.js";
import { fetchBalance } from "../../../../../src/provider-manager.js";
import { json } from "../../../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", auth: true, admin: true, csrf: true },
  async (ctx, sess) => {
    try {
      const result = await fetchBalance(ctx.env, ctx.params.id, sess.user.id);
      if (result.balance_cents === null || result.balance_cents === undefined) {
        return json({ ok: true, supported: false, message: "Provider tidak mendukung getBalance atau path belum dikonfigurasi." });
      }
      return json({ ok: true, supported: true, balance_cents: result.balance_cents });
    } catch (e) {
      return json({ error: e.message, code: e.code }, e.code === "PROVIDER_NOT_FOUND" ? 404 : 502);
    }
  },
);
