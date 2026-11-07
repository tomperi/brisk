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
  elsewhere: '',
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

describe('reactions', () => {
  const rx = (id: string, email: string, emoji: string, to: string) =>
    doc(id, 5, {
      parentId: 't',
      reaction: emoji,
      reactTo: to,
      text: '',
      createdByEmail: email,
      createdBy: email.split('@')[0],
    });
  const docs = [
    doc('t', 0),
    doc('r', 1, { parentId: 't', text: 'a reply' }),
    rx('x1', 'ana@example.com', '👍', 't'),
    rx('x2', ME, '👍', 't'),
    rx('x3', 'bo@example.com', '🎉', 'r'),
  ];

  it('shows a chip per emoji with its count and who, pressed when one is mine', () => {
    const html = threadHtml(threadOf(docs), opts);
    expect(html).toMatch(
      /class="rc on" data-act="react" data-v="👍" data-to="t" aria-pressed="true" data-tip="ana, You"/,
    );
    expect(text(html)).toContain('👍2');
    expect(text(html)).toContain('1 reply');
    expect(html).not.toContain('data-act="react-menu"');
  });

  it('offers Add reaction on the open comment and on each reply', () => {
    const html = threadHtml(threadOf(docs), { ...opts, open: true });
    expect(html).toContain('data-act="react-menu" data-to="t"');
    expect(html).toContain('data-act="react-menu" data-to="r"');
    expect(html).toMatch(
      /class="rc" data-act="react" data-v="🎉" data-to="r" aria-pressed="false"/,
    );
  });

  it('freezes the chips on a deleted thread', () => {
    const html = threadHtml(threadOf([{ ...docs[0]!, deleted: true }, ...docs.slice(1)]), {
      ...opts,
      open: true,
    });
    expect(html).not.toContain('data-act="react"');
    expect(html).toContain('disabled');
  });

  it('renders a reaction on the page as its emoji beside the quote, with no text', () => {
    const html = threadHtml(
      threadOf([doc('p', 0, { reaction: '🔥', text: '', selector: 'p', quote: 'ships today' })]),
      opts,
    );
    expect(text(html)).toContain('🔥“ships today”');
    expect(html).not.toContain('class="tx"');
    expect(html).toContain('aria-label="Unread. ana reacted 🔥"');
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
        drafts: 0,
        thread: () => opts,
      },
    );
    expect(html).toContain('data-act="filter" data-v="resolved"');
    expect(text(html)).toContain('1 unread in Resolved');
  });

  const draft = (id: string, page = '/') => ({
    id,
    text: `draft ${id}`,
    page,
    label: 'p',
    textSnippet: '',
    html: '',
    createdAt: at(9),
  });
  const render = (drafts: ReturnType<typeof draft>[], allDrafts = drafts.length) => {
    const threads = buildThreads({ drafts, docs: [doc('seen', 0)], seen: { seen: at(5) }, me: ME });
    const state = { open: true, scope: 'page' as const, filter: 'unread' as const, expanded: null };
    return panelHtml(
      panelView(threads, state, (p) => p === '/'),
      state,
      {
        site: 's',
        picking: false,
        drafts: allDrafts,
        thread: () => opts,
      },
    );
  };

  it('lists my drafts first under Unread, with a footer to copy or publish them', () => {
    const html = render([draft('d1'), draft('d2')]);
    expect(text(html)).toContain('Your drafts2');
    expect(html.indexOf('data-id="d1"')).toBeLessThan(html.indexOf('data-id="d2"'));
    expect(text(html)).toContain("You're all caught up");
    expect(html).toContain('data-act="copy-all"');
    expect(text(html)).toContain('2 drafts');
    expect(html).toMatch(/class="btn sm pri\s*" data-act="publish-all"/);
  });

  it('keeps Copy all in the footer when there are no drafts', () => {
    const html = render([]);
    expect(html).toContain('data-act="copy-all"');
    expect(html).not.toContain('data-act="publish-all"');
    expect(text(html)).not.toContain('Your drafts');
  });
});
