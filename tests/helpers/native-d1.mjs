import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

/** A real SQLite database with the small D1 surface exercised by Drizzle/Better Auth. */
export function createNativeD1() {
  const native = new DatabaseSync(':memory:');
  native.exec('PRAGMA foreign_keys = ON');
  const migrationDirectory = new URL('../../drizzle/', import.meta.url);
  for (const filename of readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort()) {
    native.exec(readFileSync(new URL(filename, migrationDirectory), 'utf8'));
  }
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    async first(columnName) {
      const row = native.prepare(this.sql).get(...this.values) || null;
      return columnName ? row?.[columnName] ?? null : row;
    }
    async all() {
      const results = native.prepare(this.sql).all(...this.values);
      return { success: true, results, meta: { changes: 0, duration: 0 } };
    }
    async raw(options) {
      const statement = native.prepare(this.sql);
      statement.setReturnArrays(true);
      const values = statement.all(...this.values);
      return options?.columnNames ? [statement.columns().map(column => column.name), ...values] : values;
    }
    runSync() {
      const statement = native.prepare(this.sql);
      if (statement.columns().length) {
        const results = statement.all(...this.values);
        return { success: true, results, meta: { changes: results.length, duration: 0 } };
      }
      const result = statement.run(...this.values);
      return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid), duration: 0 } };
    }
    async run() { return this.runSync(); }
  }
  const db = {
    prepare(sql) { return new Statement(sql); },
    async exec(sql) { native.exec(sql); return { count: 1, duration: 0 }; },
    async batch(statements) {
      native.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(statement.runSync());
        native.exec('COMMIT');
        return results;
      } catch (error) {
        native.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { native, db, close() { native.close(); } };
}
