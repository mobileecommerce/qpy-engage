// A tiny Cloudflare D1 lookalike over node:sqlite, enough for drizzle-orm/d1.
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

function normalise(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params.map(normalise));
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
  async all() {
    // node:sqlite returns null-prototype rows; D1 returns plain objects.
    const results = this.db.prepare(this.sql).all(...this.params).map((row) => ({ ...row }));
    return { results, success: true, meta: {} };
  }
  async raw() {
    const st = this.db.prepare(this.sql);
    st.setReturnArrays(true);
    return st.all(...this.params);
  }
  async first(col) {
    const raw = this.db.prepare(this.sql).get(...this.params);
    const row = raw ? { ...raw } : null;
    return col && row ? row[col] : row;
  }
}

export async function createTestD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migration = await readFile(new URL("../../../drizzle/0000_outreach.sql", import.meta.url), "utf8");
  for (const stmt of migration.split("--> statement-breakpoint")) if (stmt.trim()) db.exec(stmt);
  return {
    prepare: (sql) => new Statement(db, sql),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.all())),
    exec: async (sql) => (db.exec(sql), { count: 1, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    _raw: {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const st = db.prepare(sql);
        return { all: (...p) => st.all(...p).map((r) => ({ ...r })), get: (...p) => (st.get(...p) ? { ...st.get(...p) } : undefined) };
      },
    },
  };
}
