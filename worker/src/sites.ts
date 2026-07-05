import { contentType } from './mime';
import type { Env, User } from './env';

export interface SiteInfo {
  name: string;
  files: number;
  bytes: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  /** Self-asserted, spoofable label set once at creation. A footgun guard,
   *  never a permission — NULL (legacy/unowned) never blocks a deploy. */
  owner: string | null;
}

interface SiteRow {
  name: string;
  active_deploy: string;
  files: number;
  bytes: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  owner: string | null;
}

/** Subdomain-safe: a site name has to be a valid DNS label. */
const SITE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Names that collide with server routes or URL conventions. */
const RESERVED = new Set(['api', 'auth', 'files', 's', 'brisk', 'www']);

export function isValidSiteName(name: string): boolean {
  return SITE_NAME.test(name) && !RESERVED.has(name);
}

function toInfo(row: SiteRow): SiteInfo {
  return {
    name: row.name,
    files: row.files,
    bytes: row.bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    owner: row.owner,
  };
}

const deployPrefix = (site: string, deploy: string) => `deploys/${site}/${deploy}/`;

const keepHistory = (env: Env): boolean => env.DEPLOY_HISTORY === 'on';

/** The live-deploy pointer barely changes; cache it per isolate for a beat. */
const pointerCache = new Map<string, { deploy: string | null; expires: number }>();
const POINTER_TTL_MS = 5_000;

async function activeDeploy(env: Env, site: string): Promise<string | null> {
  const cached = pointerCache.get(site);
  if (cached && cached.expires > Date.now()) return cached.deploy;
  const row = await env.DB.prepare('SELECT active_deploy FROM sites WHERE name = ?')
    .bind(site)
    .first<{ active_deploy: string }>();
  const deploy = row?.active_deploy ?? null;
  pointerCache.set(site, { deploy, expires: Date.now() + POINTER_TTL_MS });
  return deploy;
}

export async function listSites(env: Env): Promise<SiteInfo[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM sites ORDER BY updated_at DESC',
  ).all<SiteRow>();
  return results.map(toInfo);
}

export async function getSite(env: Env, name: string): Promise<SiteInfo | null> {
  const row = await env.DB.prepare('SELECT * FROM sites WHERE name = ?')
    .bind(name)
    .first<SiteRow>();
  return row ? toInfo(row) : null;
}

/**
 * Serve `path` from a site's live deploy in R2, resolving directory indexes
 * and extensionless paths (`/about` → `/about.html`).
 */
export async function serveSite(env: Env, site: string, path: string): Promise<Response | null> {
  const deploy = await activeDeploy(env, site);
  if (!deploy) return null;

  const clean = path.replace(/^\/+/, '');
  if (clean.split('/').includes('..')) return null;
  const candidates = clean ? [clean, `${clean}/index.html`, `${clean}.html`] : ['index.html'];

  for (const candidate of candidates) {
    const object = await env.BUCKET.get(deployPrefix(site, deploy) + candidate);
    if (!object) continue;
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.has('content-type')) headers.set('content-type', contentType(candidate));
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'no-cache');
    return new Response(object.body, { headers });
  }
  return null;
}

export interface DeployFile {
  path: string;
  file: File;
}

/**
 * A UNIQUE(site,version) collision from a racing deploy. D1 surfaces these as a
 * `D1_ERROR` string whose text varies by workerd version, so match any of the
 * forms a SQLite constraint failure is known to take rather than one literal.
 */
function isConstraintViolation(err: unknown): boolean {
  const text = String(err);
  return (
    text.includes('UNIQUE') ||
    text.includes('constraint failed') ||
    text.includes('SQLITE_CONSTRAINT')
  );
}

/**
 * A deploy uploads every file under a fresh prefix, then swaps the site's
 * pointer — so a site is never served half-updated. The previous deploy is
 * pruned only after the swap, and only when DEPLOY_HISTORY isn't retaining it.
 */
export async function deploySite(
  env: Env,
  ctx: ExecutionContext,
  site: string,
  files: DeployFile[],
  user: User,
  who: string,
): Promise<SiteInfo> {
  const previous = await activeDeploy(env, site);
  const deploy = crypto.randomUUID().slice(0, 8);
  const prefix = deployPrefix(site, deploy);

  let bytes = 0;
  const queue = [...files];
  const workers = Array.from({ length: 8 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      bytes += next.file.size;
      await env.BUCKET.put(prefix + next.path, next.file.stream(), {
        httpMetadata: { contentType: contentType(next.path) },
      });
    }
  });
  await Promise.all(workers);

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO sites (name, active_deploy, files, bytes, created_at, updated_at, updated_by, owner)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       active_deploy = excluded.active_deploy,
       files = excluded.files,
       bytes = excluded.bytes,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by
     RETURNING *`,
  )
    // Attribute to the human name; auth already falls it back to the email.
    // owner is the asserted identity, set once at creation: it's absent from the
    // ON CONFLICT UPDATE, so a later deploy (even a forced overwrite) preserves it.
    .bind(site, deploy, files.length, bytes, now, now, user.name, who)
    .first<SiteRow>();
  pointerCache.delete(site);

  // Retention has two modes: DEPLOY_HISTORY=on keeps every version (rollback
  // groundwork); unset/off (default) prunes the superseded deploy below so R2
  // stays bounded. Keep-last-N pruning for the on mode is still future work.

  // Record this publish as an immutable version. The number is computed inline
  // so concurrent deploys can't read the same MAX and collide; if two still
  // race to the same value the UNIQUE(site,version) index rejects the loser,
  // and we retry once against the now-higher MAX.
  for (let attempt = 0; ; attempt++) {
    try {
      await env.DB.prepare(
        `INSERT INTO deploys (site, deploy, version, files, bytes, created_at, created_by)
         VALUES (?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM deploys WHERE site = ?), ?, ?, ?, ?)`,
      )
        .bind(site, deploy, site, files.length, bytes, now, user.name)
        .run();
      break;
    } catch (err) {
      if (attempt === 0 && isConstraintViolation(err)) continue;
      throw err;
    }
  }

  // Bounded mode (default): now that the pointer swapped and the version row
  // exists, drop the superseded deploy so R2 and `deploys` stay in lockstep —
  // every remaining row still has its files. R2 cleanup is fire-and-forget; two
  // simultaneous deploys can orphan the loser's prefix, but at internal-tool
  // scale that's rare and cheap, so we don't coordinate beyond last-write-wins.
  // The row delete is awaited so listDeploys is consistent the moment we return.
  if (!keepHistory(env) && previous && previous !== deploy) {
    ctx.waitUntil(deletePrefix(env, deployPrefix(site, previous)));
    await env.DB.prepare('DELETE FROM deploys WHERE site = ? AND deploy = ?')
      .bind(site, previous)
      .run();
  }
  return toInfo(row!);
}

export interface DeployInfo {
  deploy: string;
  version: number;
  files: number;
  bytes: number;
  createdAt: string;
  createdBy: string | null;
}

/**
 * Every retained version of a site, newest first. Read-only history; serving
 * still follows the single live pointer (`sites.active_deploy`). No route
 * consumes this yet — it backs tests and future rollback/history.
 */
export async function listDeploys(env: Env, site: string): Promise<DeployInfo[]> {
  const { results } = await env.DB.prepare(
    `SELECT deploy, version, files, bytes, created_at, created_by
     FROM deploys WHERE site = ? ORDER BY version DESC`,
  )
    .bind(site)
    .all<{
      deploy: string;
      version: number;
      files: number;
      bytes: number;
      created_at: string;
      created_by: string | null;
    }>();
  return results.map((row) => ({
    deploy: row.deploy,
    version: row.version,
    files: row.files,
    bytes: row.bytes,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }));
}

export async function listFiles(env: Env, site: string): Promise<{ path: string; size: number }[]> {
  const deploy = await activeDeploy(env, site);
  if (!deploy) return [];
  const prefix = deployPrefix(site, deploy);
  const files: { path: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor });
    files.push(...page.objects.map((o) => ({ path: o.key.slice(prefix.length), size: o.size })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return files;
}

/** Exact file from the live deploy, no index/extension resolution. */
export async function getFile(env: Env, site: string, path: string): Promise<Response | null> {
  const deploy = await activeDeploy(env, site);
  if (!deploy) return null;
  const clean = path.replace(/^\/+/, '');
  if (clean.split('/').includes('..')) return null; // parity with serveSite
  const object = await env.BUCKET.get(deployPrefix(site, deploy) + clean);
  if (!object) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  return new Response(object.body, { headers });
}

/**
 * Removes the site and everything namespaced to it: deploys, docs, uploads.
 * Returns whether the site existed, so callers can 404 a no-op delete.
 */
export async function deleteSite(env: Env, site: string): Promise<boolean> {
  const [sites] = await env.DB.batch([
    env.DB.prepare('DELETE FROM sites WHERE name = ?').bind(site),
    env.DB.prepare('DELETE FROM docs WHERE site = ?').bind(site),
    env.DB.prepare('DELETE FROM deploys WHERE site = ?').bind(site),
  ]);
  pointerCache.delete(site);
  await Promise.all([deletePrefix(env, `deploys/${site}/`), deletePrefix(env, `uploads/${site}/`)]);
  return (sites?.meta.changes ?? 0) > 0;
}

async function deletePrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
