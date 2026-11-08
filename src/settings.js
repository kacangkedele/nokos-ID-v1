// src/settings.js — baca system_settings dari D1 (key-value)
import { first, all, run } from "./db.js";
import { now } from "./utils.js";

export async function loadSettings(db) {
  const rows = await all(db, `SELECT key, value FROM system_settings`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function getSetting(db, key) {
  const row = await first(db, `SELECT value FROM system_settings WHERE key = ?`, [key]);
  return row?.value;
}

export async function setSetting(db, key, value, adminId) {
  const t = now();
  await run(
    db,
    `INSERT INTO system_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    [key, String(value), adminId, t],
  );
}
