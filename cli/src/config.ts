import fs from 'node:fs';
import path from 'node:path';

/** Per-folder config, written by `brisk init`. */
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

/** Flag > env > brisk.json > local dev default. */
export function serverUrl(flag: string | undefined, cfg: SiteConfig): string {
  const url = flag ?? process.env.BRISK_SERVER ?? cfg.server ?? 'http://localhost:8787';
  return url.replace(/\/+$/, '');
}

/** When the server runs with AUTH=google, the CLI authenticates with DEPLOY_TOKEN. */
export function authHeaders(): Record<string, string> {
  const token = process.env.BRISK_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function api<T>(server: string, route: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${server}${route}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = body;
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      /* not json */
    }
    throw new Error(
      `${init.method ?? 'GET'} ${route} → ${res.status}${message ? `: ${message}` : ''}`,
    );
  }
  return res.json() as Promise<T>;
}
