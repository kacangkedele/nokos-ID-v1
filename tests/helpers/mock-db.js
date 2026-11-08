// tests/helpers/mock-db.js
// Mock D1 Database berbasis better-sqlite3 untuk testing.
// Mengimplementasikan API: prepare(sql).bind(...).run()/first()/all()
// dan db.batch([stmts]) yang atomic (satu transaction).

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createMockDB() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  // enable foreign keys + triggers
  sqlite.pragma("foreign_keys = ON");

  // apply migrations
  const m1 = readFileSync(join(__dirname, "../../migrations/0001_init.sql"), "utf8");
  const m2 = readFileSync(join(__dirname, "../../migrations/0002_indexes.sql"), "utf8");
  const m3 = readFileSync(join(__dirname, "../../migrations/0003_multi_provider.sql"), "utf8");
  const m4 = readFileSync(join(__dirname, "../../migrations/0004_hidden_provider.sql"), "utf8");
  sqlite.exec(m1);
  sqlite.exec(m2);
  sqlite.exec(m3);
  sqlite.exec(m4);

  // wrap statement. bind() returns object with _sql + _params for batch() reuse.
  const wrapStmt = (sql) => ({
    bind(...params) {
      return {
        _sql: sql,
        _params: params,
        run: async () => {
          const info = sqlite.prepare(sql).run(...params);
          return { meta: { last_row_id: info.lastInsertRowid, changes: info.changes } };
        },
        first: async () => {
          const row = sqlite.prepare(sql).get(...params);
          return row || null;
        },
        all: async () => {
          const rows = sqlite.prepare(sql).all(...params);
          return { results: rows, meta: { changes: rows.length } };
        },
      };
    },
    // D1 mendukung .run()/.first()/.all() langsung tanpa bind() untuk query tanpa parameter.
    run: async () => {
      const info = sqlite.prepare(sql).run();
      return { meta: { last_row_id: info.lastInsertRowid, changes: info.changes } };
    },
    first: async () => {
      const row = sqlite.prepare(sql).get();
      return row || null;
    },
    all: async () => {
      const rows = sqlite.prepare(sql).all();
      return { results: rows, meta: { changes: rows.length } };
    },
  });

  const dbObj = {
    prepare(sql) {
      return wrapStmt(sql);
    },
    async batch(stmts) {
      // stmts: array of bound statement (punya _sql, _params)
      // atau array of { sql, params } (raw) — handle keduanya.
      const tx = sqlite.transaction(() => {
        const results = [];
        for (const s of stmts) {
          const sql = s._sql || s.sql;
          const params = s._params || s.params || [];
          if (typeof sql !== "string") {
            throw new Error("batch: statement sql missing");
          }
          const stmt = sqlite.prepare(sql);
          const info = stmt.run(...params);
          results.push({ meta: { last_row_id: info.lastInsertRowid, changes: info.changes } });
        }
        return results;
      });
      try {
        return tx();
      } catch (e) {
        throw e;
      }
    },
    _sqlite: sqlite,
    _close() { sqlite.close(); },
  };
  return dbObj;
}

// Mock env (Cloudflare bindings)
export function createMockEnv(db) {
  return {
    DB: db,
    RATE_LIMIT: createMockKV(),
    SESSIONS: createMockKV(),
    BUKTI: createMockR2(),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY: "test-encryption-key-32bytes-long-xxx",
    JWT_SECRET: "test-jwt-secret-32bytes",
    RUANGOTP_API_KEY: "test-provider-key",
    RUANGOTP_BASE_URL: "https://ruangotp.io/api",
    RUANGOTP_WEBHOOK_SECRET: "test-webhook-secret",
    QRIS_MERCHANT_NAME: "Angga Official",
    PROVIDER_ENABLED: "1",
  };
}

function createMockKV() {
  const store = new Map();
  return {
    async get(k) { return store.get(k) || null; },
    async put(k, v, opts) {
      store.set(k, v);
      if (opts?.expirationTtl) {
        setTimeout(() => store.delete(k), opts.expirationTtl * 1000);
      }
    },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

function createMockR2() {
  const objects = new Map();
  return {
    async put(key, data, opts) {
      objects.set(key, { data: Buffer.from(data), ...opts });
    },
    async get(key) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        body: obj.data,
        writeHttpMetadata(headers) {
          if (obj.httpMetadata?.contentType) headers.set("Content-Type", obj.httpMetadata.contentType);
        },
      };
    },
    async delete(key) { objects.delete(key); },
    _objects: objects,
  };
}
