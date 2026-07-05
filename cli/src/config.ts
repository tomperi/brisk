import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- per-folder config (brisk.json) -----------------------------------------

/** Written by `brisk init`; `server` pins a repo to a specific instance. */
export interface SiteConfig {
  site?: string;
  server?: string;
}

export function loadConfig(dir: string): SiteConfig {
  const file = path.join(dir, 'brisk.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SiteConfig;
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

// ---- profiles (~/.config/brisk/config.json) ----------------------------------

/** One per Brisk instance you've logged into, AWS-profile style. */
export interface Profile {
  server: string;
  /** Personal token from `brisk login`. Absent on AUTH=none instances. */
  token?: string;
  email?: string;
  /** Self-asserted deploy identity sent as `x-brisk-username` (owner label). */
  username?: string;
}

export interface GlobalConfig {
  current?: string;
  profiles: Record<string, Profile>;
}

export function globalConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'brisk', 'config.json');
}

export function loadGlobal(): GlobalConfig {
  const file = globalConfigPath();
  if (!fs.existsSync(file)) return { profiles: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<GlobalConfig>;
    return { ...parsed, profiles: parsed.profiles ?? {} };
  } catch {
    throw new Error(`${file} is not valid JSON — fix or delete it`);
  }
}

export function saveGlobal(cfg: GlobalConfig): void {
  const file = globalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

// ---- connection resolution -----------------------------------------------------

export interface Connection {
  server: string;
  token?: string;
  /** Which profile supplied this connection, when one did. */
  profile?: string;
}

export const normalizeServer = (url: string): string => {
  const withScheme = /^https?:\/\//.test(url)
    ? url
    : `${/^(localhost|127\.)/.test(url) ? 'http' : 'https'}://${url}`;
  return withScheme.replace(/\/+$/, '');
};

const sameInstance = (a: string, b: string): boolean => normalizeServer(a) === normalizeServer(b);

function profileMatching(cfg: GlobalConfig, server: string): [string, Profile] | undefined {
  return Object.entries(cfg.profiles).find(([, p]) => sameInstance(p.server, server));
}

/**
 * Where a command talks to, and as whom. Precedence:
 *   --profile / BRISK_PROFILE  →  that profile (its server + token)
 *   --server / BRISK_SERVER    →  that server, token from a matching profile or BRISK_TOKEN
 *   brisk.json `server`        →  same matching rule (the repo pins its instance)
 *   the active profile         →  from `brisk login` / `brisk profile use`
 *   http://localhost:8787      →  local dev fallback
 */
export function resolveConnection(
  flags: { server?: string; profile?: string },
  dir: string,
): Connection {
  const cfg = loadGlobal();

  const profileName = flags.profile ?? process.env.BRISK_PROFILE;
  if (profileName) {
    const profile = cfg.profiles[profileName];
    if (!profile) {
      const known = Object.keys(cfg.profiles).join(', ') || '(none — run brisk login)';
      throw new Error(`no profile "${profileName}" — known profiles: ${known}`);
    }
    return {
      server: normalizeServer(flags.server ?? profile.server),
      token: profile.token,
      profile: profileName,
    };
  }

  const explicit = flags.server ?? process.env.BRISK_SERVER ?? loadConfig(dir).server;
  if (explicit) {
    const server = normalizeServer(explicit);
    const match = profileMatching(cfg, server);
    return {
      server,
      token: process.env.BRISK_TOKEN ?? match?.[1].token,
      profile: match?.[0],
    };
  }

  const active = cfg.current ? cfg.profiles[cfg.current] : undefined;
  if (active) {
    return { server: normalizeServer(active.server), token: active.token, profile: cfg.current };
  }

  return { server: 'http://localhost:8787', token: process.env.BRISK_TOKEN };
}

/**
 * The identity a deploy asserts (`x-brisk-username`). Spoofable by design — a
 * trust-based owner label, never a permission. Precedence:
 *   --username flag  >  BRISK_USERNAME env  >  the resolved profile's username.
 */
export function resolveUsername(
  flags: { username?: string },
  conn: Connection,
): string | undefined {
  if (flags.username) return flags.username;
  if (process.env.BRISK_USERNAME) return process.env.BRISK_USERNAME;
  return conn.profile ? loadGlobal().profiles[conn.profile]?.username : undefined;
}

// ---- http ------------------------------------------------------------------------

export function authHeaders(conn: Connection): Record<string, string> {
  return conn.token ? { authorization: `Bearer ${conn.token}` } : {};
}

/** A non-2xx response, carrying the status and parsed body so callers can react
 *  (e.g. the 409 `owned` deploy guard). Extends Error so existing catches hold. */
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(conn: Connection, route: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${conn.server}${route}`, {
    ...init,
    headers: { ...authHeaders(conn), ...(init.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body: unknown = text;
    let message = text;
    try {
      body = JSON.parse(text);
      message = (body as { error?: string }).error ?? text;
    } catch {
      /* not json */
    }
    if (res.status === 401) {
      message = `unauthenticated — run: brisk login ${conn.server}`;
    }
    throw new ApiError(
      `${init.method ?? 'GET'} ${route} → ${res.status}${message ? `: ${message}` : ''}`,
      res.status,
      body,
    );
  }
  return res.json() as Promise<T>;
}
