// functions/api/auth/logout.js
import { withHandler } from "../../../src/middleware.js";
import { destroySession, clearCookies } from "../../../src/session.js";
import { getDB } from "../../../src/db.js";
import { json } from "../../../src/utils.js";

export const onRequestPost = withHandler(
  { method: "POST", csrf: true },
  async (ctx, sess) => {
    if (sess) {
      await destroySession(getDB(ctx.env), ctx.env.SESSIONS, ctx.request);
    }
    return json({ ok: true }, 200, { "Set-Cookie": clearCookies(ctx.env).join(", ") });
  },
);
