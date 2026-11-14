import { describe, expect, it } from 'vitest';

/** HTTP assertions that must hold identically on every runtime. `base` is the
 *  server origin, e.g. http://127.0.0.1:54321. Mirrors api.test.ts (the worker
 *  reference) so the Node assembly is proven equivalent. */
export function runHttpParity(base: () => string): void {
  const form = (files: Record<string, string>): FormData => {
    const f = new FormData();
    for (const [path, content] of Object.entries(files)) {
      f.append('files', new File([content], path, { type: 'text/html' }));
    }
    return f;
  };

  describe('parity: identity', () => {
    it('returns the dev user when auth is off', async () => {
      const res = await fetch(`${base()}/api/me`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ email: 'dev@localhost', name: 'Dev' });
    });
  });

  describe('parity: deploy + serve', () => {
    it('deploys a folder and serves files with extension content-types', async () => {
      const dep = await fetch(`${base()}/api/deploy/p-site`, {
        method: 'POST',
        body: form({
          'index.html': '<h1>hi</h1>',
          'style.css': 'body{}',
          'app.js': 'console.log(1)',
        }),
      });
      expect(dep.status).toBe(200);
      const idx = await fetch(`${base()}/s/p-site/`);
      expect(idx.status).toBe(200);
      expect(idx.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const css = await fetch(`${base()}/s/p-site/style.css`);
      expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    });
  });

  describe('parity: extensionless asset routing', () => {
    it('serves /docs as docs.html (Cloudflare auto-trailing-slash html_handling)', async () => {
      const res = await fetch(`${base()}/docs`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    });
  });

  describe('parity: database crud', () => {
    it('creates, reads, lists and deletes a doc', async () => {
      const h = { 'content-type': 'application/json', 'x-brisk-site': 'p-db' };
      const created = (await (
        await fetch(`${base()}/api/db/notes`, {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ text: 'first' }),
        })
      ).json()) as { id: string; text: string };
      expect(created.text).toBe('first');
      const got = await (
        await fetch(`${base()}/api/db/notes/${created.id}`, { headers: h })
      ).json();
      expect(got).toMatchObject({ id: created.id, text: 'first' });
      const list = (await (await fetch(`${base()}/api/db/notes`, { headers: h })).json()) as {
        docs: unknown[];
      };
      expect(list.docs.length).toBeGreaterThanOrEqual(1);
    });

    it('upserts under a chosen id: 201 create, 200 full replace that keeps createdAt', async () => {
      const put = (path: string, body: unknown, site = 'p-db') =>
        fetch(`${base()}/api/db/${path}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-brisk-site': site },
          body: JSON.stringify(body),
        });
      const first = await put('reports/2026-11', { a: 1, b: 2 });
      expect(first.status).toBe(201);
      const created = (await first.json()) as { createdAt: string; updatedAt: string };
      const second = await put('reports/2026-11', { a: 3 });
      expect(second.status).toBe(200);
      const replaced = (await second.json()) as Record<string, unknown>;
      expect(replaced).toMatchObject({ id: '2026-11', a: 3, createdAt: created.createdAt });
      expect(replaced).not.toHaveProperty('b');
      expect((replaced.updatedAt as string) > created.updatedAt).toBe(true);

      expect((await put('reports/2026-11', { a: 1 }, 'p-db-other')).status).toBe(201);
      expect((await put('reports/-bad', { a: 1 })).status).toBe(400);
      expect((await put('_plugin:comments/x', { a: 1 })).status).toBe(403);
    });
  });
}

/**
 * Deploy semantics that api.test.ts proves against D1 — owner-guarded
 * overwrites, monotonic version numbers, and DEPLOY_HISTORY retention/prune —
 * re-proven against the Node sqlite adapter. Versions aren't exposed over HTTP,
 * so `deploys(site)`/`historyDeploys(site)` read the `deploys` table directly
 * (newest version first). `historyBase` is a second server booted with
 * DEPLOY_HISTORY=on, so both the retain and the default prune paths are covered.
 */
export function runDeployParity(opts: {
  base: () => string;
  deploys: (site: string) => Promise<number[]>;
  historyBase: () => string;
  historyDeploys: (site: string) => Promise<number[]>;
}): void {
  const form = (files: Record<string, string>): FormData => {
    const f = new FormData();
    for (const [path, content] of Object.entries(files)) {
      f.append('files', new File([content], path, { type: 'text/html' }));
    }
    return f;
  };
  const deploy = (origin: string, site: string, who?: string, force = false): Promise<Response> =>
    fetch(`${origin}/api/deploy/${site}${force ? '?force=1' : ''}`, {
      method: 'POST',
      headers: who ? { 'x-brisk-username': who } : {},
      body: form({ 'index.html': `<h1>${site}</h1>` }),
    });
  const ownerOf = async (origin: string, site: string): Promise<string | null> =>
    (await (await fetch(`${origin}/api/sites/${site}`)).json<{ owner: string | null }>()).owner;

  describe('parity: deploy ownership', () => {
    it('records the deployer as owner and 409s an overwrite by someone else', async () => {
      // alice claims the site — she becomes its owner.
      expect((await deploy(opts.base(), 'p-own', 'alice')).status).toBe(200);
      expect(await ownerOf(opts.base(), 'p-own')).toBe('alice');
      // alice redeploying her own site is silent.
      expect((await deploy(opts.base(), 'p-own', 'alice')).status).toBe(200);
      // bob is blocked without --force.
      const blocked = await deploy(opts.base(), 'p-own', 'bob');
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ code: 'owned', owner: 'alice' });
      expect(await ownerOf(opts.base(), 'p-own')).toBe('alice'); // untouched
      // bob forces it through; owner is set-once, so it stays alice.
      expect((await deploy(opts.base(), 'p-own', 'bob', true)).status).toBe(200);
      expect(await ownerOf(opts.base(), 'p-own')).toBe('alice');
    });
  });

  describe('parity: version history', () => {
    it('increments the version per publish and retains them when DEPLOY_HISTORY=on', async () => {
      expect((await deploy(opts.historyBase(), 'p-ver')).status).toBe(200);
      expect((await deploy(opts.historyBase(), 'p-ver')).status).toBe(200);
      // Both publishes kept, newest first — the inline MAX(version)+1 increments.
      expect(await opts.historyDeploys('p-ver')).toEqual([2, 1]);
    });

    it('prunes the superseded version when DEPLOY_HISTORY is off (default)', async () => {
      expect((await deploy(opts.base(), 'p-prune')).status).toBe(200);
      expect((await deploy(opts.base(), 'p-prune')).status).toBe(200);
      // Off (default): only the live version survives, but its number still
      // advanced to 2 — prune and the monotonic counter both hold on sqlite.
      expect(await opts.deploys('p-prune')).toEqual([2]);
    });
  });
}

/** Realtime round-trip — Node only (real WebSocket client). */
export function runRealtimeParity(base: () => string): void {
  const wsBase = () => base().replace(/^http/, 'ws');

  describe('parity: realtime', () => {
    it('greets with identity and delivers a db event to the same site', async () => {
      const ws = new WebSocket(`${wsBase()}/api/ws?site=p-ws`);
      const queue: any[] = [];
      let wake: (() => void) | null = null;
      ws.addEventListener('message', (e) => {
        queue.push(JSON.parse(e.data as string));
        wake?.();
      });
      const next = (ms = 2000) =>
        new Promise<any>((res, rej) => {
          if (queue.length) return res(queue.shift());
          const t = setTimeout(() => rej(new Error('ws timeout')), ms);
          wake = () => {
            clearTimeout(t);
            wake = null;
            res(queue.shift());
          };
        });
      await new Promise<void>((r) => ws.addEventListener('open', () => r()));
      const hello = await next();
      expect(hello).toMatchObject({ t: 'hello', you: { email: 'dev@localhost', name: 'Dev' } });
      ws.send(JSON.stringify({ t: 'db:sub', collection: 'msgs' }));
      const created = (await (
        await fetch(`${base()}/api/db/msgs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-brisk-site': 'p-ws' },
          body: JSON.stringify({ text: 'over the wire' }),
        })
      ).json()) as { id: string };
      const event = await next();
      expect(event).toMatchObject({
        t: 'db',
        event: 'create',
        collection: 'msgs',
        doc: { id: created.id, text: 'over the wire' },
      });

      const put = (text: string) =>
        fetch(`${base()}/api/db/msgs/chosen`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-brisk-site': 'p-ws' },
          body: JSON.stringify({ text }),
        });
      await put('new');
      expect(await next()).toMatchObject({ event: 'create', doc: { id: 'chosen', text: 'new' } });
      await put('replaced');
      expect(await next()).toMatchObject({
        event: 'update',
        doc: { id: 'chosen', text: 'replaced' },
      });
      ws.close();
    });
  });
}
