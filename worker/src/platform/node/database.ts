import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
    return this.runSync();
  }

  /** Synchronous run, used inside batch() so the BEGIN..COMMIT transaction
   *  never yields the microtask queue mid-flight (see NodeDatabase.batch). */
  runSync(): { meta: { changes: number } } {
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
  // no batch(); emulate with BEGIN/COMMIT and ROLLBACK on throw. The whole
  // transaction runs synchronously (runSync, no awaits) on the shared sync
  // connection: a single `await s.run()` here would yield the microtask queue
  // mid-transaction, letting a concurrent batch() interleave its own BEGIN
  // (which then throws "transaction within a transaction") and ROLLBACK (which
  // would unwind this in-flight transaction). D1.batch() is isolated; this keeps
  // the Node path equivalent without an external mutex.
  async batch(statements: PreparedStatement[]): Promise<BatchResult[]> {
    this.db.exec('BEGIN');
    try {
      const results = statements.map((s) => (s as NodeStatement).runSync());
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
  // Ensure the file's directory exists (a fresh PVC mount or local dev dir
  // won't), since DatabaseSync won't create parents. `:memory:` resolves to '.'.
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
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
