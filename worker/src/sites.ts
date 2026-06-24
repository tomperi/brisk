import { contentType } from './mime';
import type { User } from './env';
import type { Platform } from './platform/types';

export interface SiteInfo {
  name: string;
  files: number;
  bytes: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface SiteRow {
  name: string;
  active_deploy: string;
  files: number;
  bytes: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
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
  };
}

const deployPrefix = (site: string, deploy: string) => `deploys/${site}/${deploy}/`;

/** The live-deploy pointer barely changes; cache it per isolate for a beat. */
const pointerCache = new Map<string, { deploy: string | null; expires: number }>();
const POINTER_TTL_MS = 5_000;

async function activeDeploy(platform: Platform, site: string): Promise<string | null> {
  const cached = pointerCache.get(site);
  if (cached && cached.expires > Date.now()) return cached.deploy;
  const row = await platform.db
    .prepare('SELECT active_deploy FROM sites WHERE name = ?')
    .bind(site)
    .first<{ active_deploy: string }>();
  const deploy = row?.active_deploy ?? null;
  pointerCache.set(site, { deploy, expires: Date.now() + POINTER_TTL_MS });
  return deploy;
}

export async function listSites(platform: Platform): Promise<SiteInfo[]> {
  const { results } = await platform.db
    .prepare('SELECT * FROM sites ORDER BY updated_at DESC')
    .all<SiteRow>();
  return results.map(toInfo);
}

export async function getSite(platform: Platform, name: string): Promise<SiteInfo | null> {
  const row = await platform.db
    .prepare('SELECT * FROM sites WHERE name = ?')
    .bind(name)
    .first<SiteRow>();
  return row ? toInfo(row) : null;
}

/**
 * Serve `path` from a site's live deploy in R2, resolving directory indexes
 * and extensionless paths (`/about` → `/about.html`).
 */
export async function serveSite(
  platform: Platform,
  site: string,
  path: string,
): Promise<Response | null> {
  const deploy = await activeDeploy(platform, site);
  if (!deploy) return null;

  const clean = path.replace(/^\/+/, '');
  if (clean.split('/').includes('..')) return null;
  const candidates = clean ? [clean, `${clean}/index.html`, `${clean}.html`] : ['index.html'];

  for (const candidate of candidates) {
    const object = await platform.storage.get(deployPrefix(site, deploy) + candidate);
    if (!object) continue;
    const headers = new Headers();
    headers.set('content-type', object.contentType ?? contentType(candidate));
    headers.set('etag', object.etag);
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
 * A deploy uploads every file under a fresh prefix, then swaps the site's
 * pointer — so a site is never served half-updated, and the previous deploy
 * is cleaned up only after the swap.
 */
export async function deploySite(
  platform: Platform,
  site: string,
  files: DeployFile[],
  user: User,
): Promise<SiteInfo> {
  const previous = await activeDeploy(platform, site);
  const deploy = crypto.randomUUID().slice(0, 8);
  const prefix = deployPrefix(site, deploy);

  let bytes = 0;
  const queue = [...files];
  const workers = Array.from({ length: 8 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      bytes += next.file.size;
      await platform.storage.put(prefix + next.path, next.file.stream(), {
        contentType: contentType(next.path),
      });
    }
  });
  await Promise.all(workers);

  const now = new Date().toISOString();
  const row = await platform.db
    .prepare(
      `INSERT INTO sites (name, active_deploy, files, bytes, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       active_deploy = excluded.active_deploy,
       files = excluded.files,
       bytes = excluded.bytes,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by
     RETURNING *`,
    )
    // Attribute to the human name; auth already falls it back to the email.
    .bind(site, deploy, files.length, bytes, now, now, user.name)
    .first<SiteRow>();
  pointerCache.delete(site);

  // Two simultaneous deploys can orphan the loser's prefix; at internal-tool
  // scale that's rare and cheap, so we don't coordinate beyond last-write-wins.
  if (previous && previous !== deploy) {
    platform.waitUntil(deletePrefix(platform, deployPrefix(site, previous)));
  }
  return toInfo(row!);
}

export async function listFiles(
  platform: Platform,
  site: string,
): Promise<{ path: string; size: number }[]> {
  const deploy = await activeDeploy(platform, site);
  if (!deploy) return [];
  const prefix = deployPrefix(site, deploy);
  const files: { path: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await platform.storage.list({ prefix, cursor });
    files.push(...page.objects.map((o) => ({ path: o.key.slice(prefix.length), size: o.size })));
    cursor = page.cursor;
  } while (cursor);
  return files;
}

/** Exact file from the live deploy, no index/extension resolution. */
export async function getFile(
  platform: Platform,
  site: string,
  path: string,
): Promise<Response | null> {
  const deploy = await activeDeploy(platform, site);
  if (!deploy) return null;
  const clean = path.replace(/^\/+/, '');
  if (clean.split('/').includes('..')) return null; // parity with serveSite
  const object = await platform.storage.get(deployPrefix(site, deploy) + clean);
  if (!object) return null;
  const headers = new Headers();
  if (object.contentType) headers.set('content-type', object.contentType);
  headers.set('etag', object.etag);
  return new Response(object.body, { headers });
}

/**
 * Removes the site and everything namespaced to it: deploys, docs, uploads.
 * Returns whether the site existed, so callers can 404 a no-op delete.
 */
export async function deleteSite(platform: Platform, site: string): Promise<boolean> {
  const [sites] = await platform.db.batch([
    platform.db.prepare('DELETE FROM sites WHERE name = ?').bind(site),
    platform.db.prepare('DELETE FROM docs WHERE site = ?').bind(site),
  ]);
  pointerCache.delete(site);
  await Promise.all([
    deletePrefix(platform, `deploys/${site}/`),
    deletePrefix(platform, `uploads/${site}/`),
  ]);
  return (sites?.meta.changes ?? 0) > 0;
}

async function deletePrefix(platform: Platform, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await platform.storage.list({ prefix, cursor });
    if (page.objects.length) await platform.storage.delete(page.objects.map((o) => o.key));
    cursor = page.cursor;
  } while (cursor);
}
