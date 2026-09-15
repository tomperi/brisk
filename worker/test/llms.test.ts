import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** /llms.txt is a generated asset (worker/scripts/build-llms.mjs, run by `pnpm
 *  build`) with its own route. These pin that the build output is wired
 *  through and carries each source it is assembled from; who may read it is
 *  auth.test.ts's business. */
describe('/llms.txt', () => {
  it('serves the generated file as plain text', async () => {
    const res = await SELF.fetch('http://localhost/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await res.text();
    expect(body.startsWith('# Brisk\n')).toBe(true);
    expect(body).toContain('## For coding agents: install the Brisk skill');
    expect(body).toContain('raw.githubusercontent.com/tomperi/brisk/main/skills/brisk/SKILL.md');
    expect(body).toContain('## Building and deploying Brisk apps'); // the skill itself
    expect(body).toContain('brisk plugin list'); // plugin discovery
    expect(body).toContain("brisk.db.collection('posts')"); // /docs
    expect(body).toContain('## Hosting Brisk'); // /host
    expect(body).toContain('## Architecture'); // README
    expect(body).toContain('## Changelog');
  });

  it("is the apex's file — on a site's host the path is that site's own", async () => {
    const form = new FormData();
    form.append('files', new File(["the site's own llms.txt"], 'llms.txt'));
    await SELF.fetch('http://localhost/api/deploy/ownfile', { method: 'POST', body: form });
    const own = await SELF.fetch('http://ownfile.localhost/llms.txt');
    expect(await own.text()).toBe("the site's own llms.txt");
    expect((await SELF.fetch('http://nosuchsite.localhost/llms.txt')).status).toBe(404);
  });
});
