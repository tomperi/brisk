import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { contentType } from '../../mime';
import type { AssetServer } from '../types';

/** Serves bundled assets (dashboard, /brisk.js) from disk. Implements the
 *  AssetServer.fetch(path) contract directly (serveStatic is middleware and
 *  resolves against cwd, so it's unsuitable). Guards against path traversal.
 *  Directory paths (`/`, `/foo/`) map to `index.html`, and extensionless paths
 *  (`/docs`, `/host`) map to `<name>.html`, matching how the Cloudflare ASSETS
 *  binding resolves them (html_handling defaults to "auto-trailing-slash"). */
export function createDiskAssets(rootDir: string): AssetServer {
  const root = resolve(rootDir);
  const send = async (file: string): Promise<Response | null> => {
    try {
      const s = await stat(file);
      if (!s.isFile()) return null;
      const buf = await readFile(file);
      return new Response(buf, {
        headers: { 'content-type': contentType(file), 'content-length': String(s.size) },
      });
    } catch {
      return null;
    }
  };
  return {
    async fetch(path: string): Promise<Response> {
      const rel = path.replace(/^[/\\]+/, '').replaceAll('\\', '/');
      const file = resolve(root, rel);
      if (file !== root && !file.startsWith(root + sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      const direct = await send(file);
      if (direct) return direct;
      // Bare path or directory → index.html (the dashboard's `/` lands here).
      if (rel === '' || path.endsWith('/')) {
        const index = await send(resolve(file, 'index.html'));
        if (index) return index;
      }
      // Extensionless path → `<name>.html` (Cloudflare's auto-trailing-slash
      // html_handling: the dashboard links to /docs and /host on disk as
      // docs.html / host.html).
      const base = rel.split('/').pop() ?? '';
      if (base !== '' && !base.includes('.')) {
        const html = await send(resolve(root, `${rel}.html`));
        if (html) return html;
      }
      return new Response('Not found', { status: 404 });
    },
  };
}
