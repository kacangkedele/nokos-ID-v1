// functions/api/deposits/[id]/proof.js
//   POST /api/deposits/:id/proof — upload bukti pembayaran ke R2 (multipart)
import { withHandler } from "../../../../src/middleware.js";
import { attachProof } from "../../../../src/deposit.js";
import { validateProofFile, detectMime } from "../../../../src/validation.js";
import { json } from "../../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", auth: true, csrf: true, rateBucket: "upload_proof",
    rateIdFrom: (ctx) => ctx.sess?.user?.id || "anon" },
  async (ctx, sess) => {
    const depositId = ctx.params.id;
    const formData = await ctx.request.formData().catch(() => null);
    if (!formData) return json({ error: "Multipart form-data diperlukan" }, 400);
    const file = formData.get("proof");
    if (!file || typeof file === "string") return json({ error: "Field 'proof' wajib file gambar" }, 400);

    try { validateProofFile(file); } catch (e) {
      return json({ error: e.message, field: e.field }, 422);
    }

    // validasi konten (magic bytes), bukan hanya MIME header dari browser
    const bytes = new Uint8Array(await file.arrayBuffer());
    const realMime = detectMime(bytes);
    if (realMime === "unknown" || !["image/jpeg", "image/png", "image/webp"].includes(realMime)) {
      return json({ error: "Konten file tidak valid (bukan gambar JPG/PNG/WebP)." }, 422);
    }

    const result = await attachProof(ctx.env.DB, ctx.env, depositId, sess.user.id, file, realMime);
    return json({ ok: true, proof: { key: result.key, mime: result.mime }, status: "pending" });
  },
);
