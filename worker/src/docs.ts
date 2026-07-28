import type { Database } from './platform/types';

export interface Doc {
  id: string;
  createdAt: string;
  updatedAt: string;
  [field: string]: unknown;
}

export interface CollectionInfo {
  name: string;
  count: number;
}

const MAX_LIMIT = 500;

/**
 * `id` / `createdAt` / `updatedAt` are ours; user fields can't shadow them. We
 * also drop a `__proto__` key: writes are shallow-spread / JSON-only today so
 * prototype pollution is inert, but stripping it here keeps that safe if anyone
 * ever introduces a recursive deep-merge over these fields.
 */
function ownFields(fields: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, createdAt: _c, updatedAt: _u, ['__proto__']: _p, ...rest } = fields;
  return rest;
}

interface DocRow {
  id: string;
  data: string;
  created_at: string;
  updated_at: string;
}

function toDoc(row: DocRow): Doc {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(JSON.parse(row.data) as Record<string, unknown>),
  };
}

/**
 * The Firebase-style document store behind `brisk.db`: schemaless JSON docs in
 * named collections, namespaced per site. No schemas, no migrations — treat it
 * like a big persisted JSON store.
 */
export class DocStore {
  constructor(private readonly db: Database) {}

  async list(
    site: string,
    collection: string,
    opts: { limit?: number; sort?: string } = {},
  ): Promise<Doc[]> {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), MAX_LIMIT);
    const order = opts.sort === '-created' ? 'DESC' : 'ASC';
    const { results } = await this.db
      .prepare(
        `SELECT * FROM docs WHERE site = ? AND collection = ?
         ORDER BY created_at ${order}, id ${order} LIMIT ?`,
      )
      .bind(site, collection, limit)
      .all<DocRow>();
    return results.map(toDoc);
  }

  async get(site: string, collection: string, id: string): Promise<Doc | null> {
    const row = await this.db
      .prepare('SELECT * FROM docs WHERE site = ? AND collection = ? AND id = ?')
      .bind(site, collection, id)
      .first<DocRow>();
    return row ? toDoc(row) : null;
  }

  async create(site: string, collection: string, fields: Record<string, unknown>): Promise<Doc> {
    const data = ownFields(fields);
    const now = new Date().toISOString();
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    await this.db
      .prepare(
        'INSERT INTO docs (site, collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(site, collection, id, JSON.stringify(data), now, now)
      .run();
    return { id, createdAt: now, updatedAt: now, ...data };
  }

  /**
   * Shallow-merges `fields` into the existing doc, Firebase-update style.
   * With `ifUpdatedAt`, the write is a compare-and-swap: it only lands if the
   * row still matches that snapshot, and returns `null` when a concurrent
   * writer got there first — otherwise this read-merge-write would silently
   * overwrite their change with our merged copy.
   */
  async update(
    site: string,
    collection: string,
    id: string,
    fields: Record<string, unknown>,
    opts: { ifUpdatedAt?: string } = {},
  ): Promise<Doc | null> {
    const existing = await this.get(site, collection, id);
    if (!existing) return null;
    if (opts.ifUpdatedAt !== undefined && existing.updatedAt !== opts.ifUpdatedAt) return null;
    const { id: _id, createdAt, updatedAt, ...current } = existing;
    const merged = { ...current, ...ownFields(fields) };
    // updated_at doubles as the CAS token, so a successful write must always
    // move it: same-millisecond writes (create-then-update on sub-ms SQLite)
    // would otherwise leave a stale snapshot's guard passing. The bump is also
    // monotonic per doc under clock skew.
    const now = new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString();
    const guarded = opts.ifUpdatedAt !== undefined;
    const stmt = this.db.prepare(
      `UPDATE docs SET data = ?, updated_at = ? WHERE site = ? AND collection = ? AND id = ?${guarded ? ' AND updated_at = ?' : ''}`,
    );
    const res = await (
      guarded
        ? stmt.bind(JSON.stringify(merged), now, site, collection, id, updatedAt)
        : stmt.bind(JSON.stringify(merged), now, site, collection, id)
    ).run();
    if (res.meta.changes === 0) return null;
    return { id, createdAt, updatedAt: now, ...merged };
  }

  async delete(site: string, collection: string, id: string): Promise<boolean> {
    const res = await this.db
      .prepare('DELETE FROM docs WHERE site = ? AND collection = ? AND id = ?')
      .bind(site, collection, id)
      .run();
    return res.meta.changes > 0;
  }

  async collections(site: string): Promise<CollectionInfo[]> {
    const { results } = await this.db
      .prepare(
        'SELECT collection AS name, COUNT(*) AS count FROM docs WHERE site = ? GROUP BY collection ORDER BY collection',
      )
      .bind(site)
      .all<CollectionInfo>();
    return results;
  }
}
