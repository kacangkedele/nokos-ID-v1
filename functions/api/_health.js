// functions/api/_health.js — health check publik (tanpa auth)
export function onRequestGet() {
  return Response.json({ ok: true, service: "Nokos.ID", version: "2.0.0", time: Math.floor(Date.now() / 1000) });
}
