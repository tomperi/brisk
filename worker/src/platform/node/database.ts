import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchResult, Database, PreparedStatement } from '../types';

/**
 * Wraps Node's synchronous node:sqlite into the async, D1-shaped Database
 * interface. node:sqlite has no .bind(): params are passed to get/all/run, so we
 * buffer them in .bind() (returning a fresh instance, like D1) and apply on
 * first()/all()/run(). The engine is sync; results are wrapped in resolved
 * promises (no real await cost) for Brisk's light per-site workloads.
 */
class NodeStatement implements PreparedStatement {
  private args: unknown[] = [];
  constructor(private readonly stmt: StatementSync) {}

  bind(...values: unknown[]): PreparedStatement {
    const next = new NodeStatement(this.stmt);
    next.args = values;
    return next;
  }

  async first<T = unknown>(): Promise<T | null> {
    // node:sqlite returns undefined for no rows; D1's contract is null.
    return (this.stmt.get(...(this.args as never[])) as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: this.stmt.all(...(this.args as never[])) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const { changes } = this.stmt.run(...(this.args as never[]));
    return { meta: { changes: Number(changes) } }; // changes can be bigint
  }
}

export class NodeDatabase implements Database {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): PreparedStatement {
    return new NodeStatement(this.db.prepare(sql));
  }

  // D1.batch() runs all statements in one implicit transaction. node:sqlite has
  // no batch(); emulate with BEGIN/COMMIT and ROLLBACK on throw.
  async batch(statements: PreparedStatement[]): Promise<BatchResult[]> {
    this.db.exec('BEGIN');
    try {
      const results: BatchResult[] = [];
      for (const s of statements) results.push(await s.run());
      this.db.exec('COMMIT');
      return results;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Open the SQLite file and apply pending `migrations/*.sql` in lexical order,
 * guarded by a `_migrations` table — reusing the same migration SQL the
 * Cloudflare D1 path uses. `exec()` runs the multi-statement .sql files.
 */
export function openNodeDatabase(file: string, migrationsDir: string): NodeDatabase {
  const raw = new DatabaseSync(file, { timeout: 5000 });
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  const applied = new Set(
    (raw.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );
  for (const f of readdirSync(migrationsDir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    if (applied.has(f)) continue;
    raw.exec('BEGIN');
    try {
      raw.exec(readFileSync(join(migrationsDir, f), 'utf8'));
      raw.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  }
  return new NodeDatabase(raw);
}
