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
      ws.close();
    });
  });
}
