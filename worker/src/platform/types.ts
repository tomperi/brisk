import type { User } from '../env';

/**
 * Platform-neutral seams. `core` (app/sites/docs) depends only on these
 * interfaces plus Web-standard APIs; concrete adapters live under
 * `platform/<runtime>/` and are wired in by the entry point. Every shape here
 * mirrors exactly what the current Cloudflare code already uses.
 */

// ---- storage (R2 ↔ S3 ↔ filesystem) --------------------------------------

export interface StoredObject {
  body: ReadableStream;
  /** Stored Content-Type, if any was recorded on write. */
  contentType?: string;
  etag: string;
  size: number;
}

export interface ListedObject {
  key: string;
  size: number;
}

export interface ListResult {
  objects: ListedObject[];
  /** Set only when the listing was truncated — drives the pagination loop. */
  cursor?: string;
}

export interface Storage {
  get(key: string): Promise<StoredObject | null>;
  put(
    key: string,
    body: ReadableStream | ArrayBuffer,
    opts?: { contentType?: string },
  ): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<ListResult>;
  delete(keys: string[]): Promise<void>;
}

// ---- database (D1 ↔ SQLite ↔ Postgres) -----------------------------------
// Shape matches D1 so the Cloudflare adapter is the binding itself.

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface BatchResult {
  meta: { changes: number };
}

export interface Database {
  prepare(sql: string): PreparedStatement;
  batch(statements: PreparedStatement[]): Promise<BatchResult[]>;
}

// ---- realtime (Durable Object ↔ in-process ↔ Redis) ----------------------

export interface DbEvent {
  collection: string;
  event: 'create' | 'update' | 'delete';
  doc?: Record<string, unknown>;
  id?: string;
}

export interface Rooms {
  /** Fan out a db change event to subscribers of `site`. */
  publish(site: string, event: DbEvent): Promise<void>;
  /** Handle a websocket upgrade for `site`; returns the 101 response. */
  connect(site: string, request: Request, user: User): Promise<Response>;
}

// ---- static assets (the dashboard / brisk.js) ----------------------------

export interface AssetServer {
  /** Fetch a bundled asset by path (e.g. `/docs.html`, `/brisk.js`). */
  fetch(path: string): Promise<Response>;
}

// ---- edge/response cache (visitor mode) ----------------------------------

export interface Cache {
  match(key: string): Promise<Response | null>;
  put(key: string, response: Response): Promise<void>;
}

// ---- the bundle handed to every request ----------------------------------

export interface Platform {
  storage: Storage;
  db: Database;
  rooms: Rooms;
  assets: AssetServer;
  cache: Cache;
  /** Run background work without blocking the response. */
  waitUntil: (p: Promise<unknown>) => void;
}
