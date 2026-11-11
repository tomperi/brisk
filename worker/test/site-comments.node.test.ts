import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { siteComments } from '../src/plugins/comments/site-comments';
import type { Draft } from '../src/plugins/comments/threads';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

let calls: Call[];
let store: Map<string, string>;
let holdActions: Promise<void> | null;

beforeEach(() => {
  calls = [];
  store = new Map();
  holdActions = null;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
  });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, headers: { ...(init.headers as Record<string, string>) }, body });
    if (method === 'POST') {
      if (holdActions) await holdActions;
      return Response.json({ result: { id: 'c1', createdAt: '2026-11-11T00:00:00.000Z' } });
    }
    return Response.json({ docs: [] });
  });
});
afterEach(() => vi.unstubAllGlobals());

const open = (site: string) =>
  siteComments(site, {
    me: Promise.resolve({ email: 'tom@example.com', name: 'Tom' }),
    changed: () => {},
  });
const settle = () => new Promise((r) => setTimeout(r, 0));
const draft = (id: string): Draft => ({
  id,
  text: `draft ${id}`,
  page: '/x.html',
  selector: '',
  label: 'p',
  textSnippet: '',
  html: '',
  createdAt: '2026-11-11T00:00:00.000Z',
});
const posts = () => calls.filter((c) => c.method === 'POST');

describe('siteComments', () => {
  it('reads the comments and the read state of its own site', async () => {
    const s = open('inner');
    await s.loaded;
    await settle();
    const reads = calls.filter((c) => c.method === 'GET');
    expect(reads.map((c) => c.url.split('?')[0])).toEqual(
      expect.arrayContaining(['/api/db/_plugin:comments', '/api/db/_plugin:comments:seen']),
    );
    for (const c of reads) expect(c.headers['x-brisk-site']).toBe('inner');
  });

  it('sends every action to its own site, whatever site the caller passes', async () => {
    const s = open('inner');
    await s.act('reply', { id: 't1', text: 'hi', site: 'outer' });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe('/api/plugins/comments/actions/reply');
    expect(posts()[0]!.body).toEqual({ args: { id: 't1', text: 'hi', site: 'inner' } });
  });

  it('keeps drafts per site across page loads', () => {
    open('inner').saveDraft(draft('d1'));
    expect(JSON.parse(store.get('brisk:comments:inner:drafts')!)).toEqual([draft('d1')]);
    expect(open('inner').drafts()).toEqual([draft('d1')]);
    expect(open('outer').drafts()).toEqual([]);
  });

  it('publishes a draft once when publish is called again while the first is in flight', async () => {
    const s = open('inner');
    s.saveDraft(draft('d1'));
    let release!: () => void;
    holdActions = new Promise((r) => (release = r));
    const first = s.publish('d1');
    const second = s.publish('d1');
    release();
    expect(await first).toEqual(await second);
    const creates = posts().filter((c) => c.url.endsWith('/actions/create'));
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body).toMatchObject({ args: { text: 'draft d1', site: 'inner' } });
    expect(s.drafts()).toEqual([]);
    expect(await s.publish('d1')).toBeNull();
  });
});
