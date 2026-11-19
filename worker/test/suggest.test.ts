import { SELF, createExecutionContext, env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { buildCloudflarePlatform } from '../src/platform/cloudflare/platform';
import { SuggestNotConfiguredError, suggestLabels } from '../src/suggest';

const HOST = 'http://localhost';
const env = { TYPESAFE_API_KEY: 'k' } as Env;
const counts = (...labels: string[]) => labels.map((label, i) => ({ label, sites: 10 - i }));

/** Stubs Jev: answers each question with the probability `byLabel` gives its label. */
function stubJev(byLabel: Record<string, number>) {
  const sent: { questions: Record<string, { instructions: string }> }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push(body);
    const answers = Object.fromEntries(
      Object.entries(body.questions as Record<string, { instructions: string }>).map(([id, q]) => [
        id,
        { type: 'noul', noul: byLabel[q.instructions.match(/"(.+?)"/)![1]!] ?? 0 },
      ]),
    );
    return Response.json({ model: 'jev-test', answers });
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe('suggestLabels', () => {
  it('keeps labels at 0.7 or above, best first, at most five', async () => {
    stubJev({ a: 0.9, b: 0.69, c: 0.7, d: 0.95, e: 0.8, f: 0.85, g: 0.75 });
    const got = await suggestLabels(env, 'x', counts('a', 'b', 'c', 'd', 'e', 'f', 'g'));
    expect(got.map((s) => s.label)).toEqual(['d', 'a', 'f', 'e', 'g']);
    expect(got[0]).toEqual({ label: 'd', sites: 7, probability: 0.95 });
  });

  it('returns [] when no label reaches 0.7', async () => {
    stubJev({ a: 0.5 });
    expect(await suggestLabels(env, 'x', counts('a', 'b'))).toEqual([]);
  });

  it('asks about the 200 most used labels only, in one request', async () => {
    const sent = stubJev({});
    const many = Array.from({ length: 250 }, (_, i) => ({ label: `l-${i}`, sites: 250 - i }));
    await suggestLabels(env, 'x', many);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.questions)).toHaveLength(200);
  });

  it('fails instead of reporting "no match" when Jev errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 429 }));
    await expect(suggestLabels(env, 'x', counts('a'))).rejects.toThrow('TypeSafe error 429');
  });

  it('needs TYPESAFE_API_KEY', async () => {
    await expect(suggestLabels({} as Env, 'x', counts('a'))).rejects.toBeInstanceOf(
      SuggestNotConfiguredError,
    );
  });
});

describe('GET /api/labels/suggested', () => {
  it('wants a description of at most 500 characters', async () => {
    expect((await SELF.fetch(`${HOST}/api/labels/suggested`)).status).toBe(400);
    const long = 'x'.repeat(501);
    expect((await SELF.fetch(`${HOST}/api/labels/suggested?description=${long}`)).status).toBe(400);
  });

  it('answers 501 on an instance without TYPESAFE_API_KEY', async () => {
    const res = await SELF.fetch(`${HOST}/api/labels/suggested?description=a%20dashboard`);
    expect(res.status).toBe(501);
  });

  const app = createApp((c) => buildCloudflarePlatform(c.env, c.executionCtx));
  const suggested = () =>
    app.fetch(
      new Request(`${HOST}/api/labels/suggested?description=a%20CVE%20dashboard`),
      { ...testEnv, TYPESAFE_API_KEY: 'k' },
      createExecutionContext(),
    );

  it('returns the fitting labels with match: true', async () => {
    const deployed = await SELF.fetch(`${HOST}/api/deploy/suggest-route`, {
      method: 'POST',
      body: (() => {
        const form = new FormData();
        form.append('files', new File(['x'], 'index.html'));
        return form;
      })(),
      headers: { 'x-brisk-labels': JSON.stringify(['suggest-fit']) },
    });
    expect(deployed.status).toBe(200);
    stubJev({ 'suggest-fit': 0.9 });
    const res = await suggested();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      labels: [{ label: 'suggest-fit', sites: 1, probability: 0.9 }],
      match: true,
    });
  });

  it('answers 502, never "no match", when Jev fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 429 }));
    const res = await suggested();
    expect(res.status).toBe(502);
    expect((await res.json<{ error: string }>()).error).toContain('TypeSafe error 429');
  });
});
