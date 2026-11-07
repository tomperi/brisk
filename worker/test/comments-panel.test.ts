import { describe, expect, it } from 'vitest';
import { panelHtml, spotName, threadHtml, type ThreadOpts } from '../src/plugins/comments/panel';
import { buildThreads, panelView, type StoredDoc } from '../src/plugins/comments/threads';

const ME = 'tom@example.com';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 4, 9, minute)).toISOString();
const doc = (id: string, minute: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    createdAt: at(minute),
    createdBy: 'ana',
    createdByEmail: 'ana@example.com',
    text: `text ${id}`,
    page: '/',
    ...extra,
  }) as StoredDoc;
const opts: ThreadOpts = {
  open: false,
  armed: false,
  since: undefined,
  lost: false,
  me: ME,
  surface: 'panel',
};
const threadOf = (d: StoredDoc[], seen: Record<string, string> = {}) =>
  buildThreads({ drafts: [], docs: d, seen, me: ME })[0]!;
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('spotName', () => {
  it('takes the first non-blank candidate, cut at its first line break', () => {
    expect(spotName([null, '  ', 'Enterprise\n  Custom pricing', 'div.card'])).toBe('Enterprise');
    expect(spotName(['A'.repeat(60)])).toBe(`${'A'.repeat(40)}…`);
    expect(spotName([])).toBe('');
  });

  it('says a stored tag label or selector in words, never as code', () => {
    expect(spotName(['', undefined, 'div#big.card'])).toBe('Section “big”');
    expect(spotName(['p'])).toBe('Paragraph');
    expect(spotName(['button.cta-primary'])).toBe('Button “cta primary”');
    expect(spotName(['body > main > p:nth-of-type(3)'])).toBe('Paragraph');
    expect(spotName(['#pricing-card'])).toBe('Section “pricing card”');
    expect(spotName(['faq'])).toBe('faq');
    expect(spotName(['Watch the video'])).toBe('Watch the video');
    expect(spotName(['Skip to main'])).toBe('Skip to main');
  });
});

describe('threadHtml', () => {
  it('names an element spot by its label and never its live text', () => {
    const html = threadHtml(
      threadOf([
        doc('t', 0, {
          selector: '#big',
          point: '0.9,0.1',
          label: 'Enterprise',
          textSnippet: 'Enterprise Custom pricing, SSO',
        }),
      ]),
      opts,
    );
    expect(text(html)).toContain('Enterprise · top right');
    expect(text(html)).not.toContain('Custom pricing');
  });

  it('falls back to the stored text, first line only, for an unlabelled old comment', () => {
    const html = threadHtml(
      threadOf([doc('t', 0, { selector: '#x', textSnippet: 'Hello' })]),
      opts,
    );
    expect(text(html)).toContain('Hello');
  });

  it('marks how many replies are new since my last visit', () => {
    const thread = threadOf(
      [
        doc('t', 0),
        doc('r1', 2, { parentId: 't' }),
        doc('r2', 7, { parentId: 't' }),
        doc('r3', 8, { parentId: 't' }),
      ],
      { t: at(5) },
    );
    expect(text(threadHtml(thread, opts))).toContain('3 replies·2 new');
  });

  it('gives each time a machine datetime and a full date on hover', () => {
    const html = threadHtml(threadOf([doc('t', 0)]), opts);
    expect(html).toMatch(
      new RegExp(`<time class="tm" datetime="${at(0)}" title="[^"]*2026[^"]*">`),
    );
  });
});

describe('panelHtml', () => {
  it('points to unread threads the active filter hides', () => {
    const threads = buildThreads({
      drafts: [],
      docs: [doc('open', 0), doc('done', 1, { resolved: true })],
      seen: { open: at(3) },
      me: ME,
    });
    const state = { open: true, scope: 'page' as const, filter: 'open' as const, expanded: null };
    const html = panelHtml(
      panelView(threads, state, () => true),
      state,
      {
        site: 's',
        picking: false,
        thread: () => opts,
      },
    );
    expect(html).toContain('data-act="filter" data-v="resolved"');
    expect(text(html)).toContain('1 unread in Resolved');
  });
});
