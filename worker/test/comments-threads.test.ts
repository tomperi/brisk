import { describe, expect, it } from 'vitest';
import {
  buildThreads,
  isNewReply,
  panelView,
  parseFilter,
  pinShown,
  type Draft,
  type Expanded,
  type StoredDoc,
} from '../src/plugins/comments/threads';

const ME = 'tom@example.com';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 4, 9, minute)).toISOString();
const doc = (id: string, email: string, minute: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    createdAt: at(minute),
    createdBy: email.split('@')[0],
    createdByEmail: email,
    text: `text ${id}`,
    page: '/',
    ...extra,
  }) as StoredDoc;
const draft = (id: string, minute: number, page = '/'): Draft => ({
  id,
  text: `draft ${id}`,
  page,
  label: 'p',
  textSnippet: '',
  html: '',
  createdAt: at(minute),
});
const here = (page: string) => page === '/';
const threadsOf = (docs: StoredDoc[], seen: Record<string, string> = {}, drafts: Draft[] = []) =>
  buildThreads({ drafts, docs, seen, me: ME });
const ids = (view: ReturnType<typeof panelView>) =>
  view.groups.flatMap((g) => g.threads.map((t) => t.id));

describe('buildThreads', () => {
  it('joins replies to their thread oldest first and hides deleted ones', () => {
    const [t] = threadsOf([
      doc('a', 'ana@example.com', 0),
      doc('r2', ME, 5, { parentId: 'a' }),
      doc('r1', 'bo@example.com', 2, { parentId: 'a' }),
      doc('r3', 'bo@example.com', 7, { parentId: 'a', deleted: true }),
    ]);
    expect(t!.replies.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(t!.activityAt).toBe(at(5));
  });

  it('marks unread from the seen stamps and never a draft', () => {
    const threads = threadsOf(
      [doc('a', 'ana@example.com', 0), doc('b', 'ana@example.com', 1)],
      { a: at(3) },
      [draft('d', 2)],
    );
    expect(Object.fromEntries(threads.map((t) => [t.id, t.unread]))).toEqual({
      a: false,
      b: true,
      d: false,
    });
  });

  it('numbers each author chronologically, drafts counting as mine', () => {
    const threads = threadsOf(
      [doc('a', ME, 0), doc('b', 'ana@example.com', 1), doc('c', ME, 3)],
      {},
      [draft('d', 4)],
    );
    expect(Object.fromEntries(threads.map((t) => [t.id, t.num]))).toEqual({
      a: 1,
      b: 1,
      c: 2,
      d: 3,
    });
  });

  it('reads status and who set it', () => {
    const [r, d] = threadsOf([
      doc('r', ME, 0, { resolved: true, resolvedBy: 'Ana' }),
      doc('d', ME, 1, { deleted: true, deletedBy: 'Bo' }),
    ]);
    expect([r!.status, r!.statusBy, d!.status, d!.statusBy]).toEqual([
      'resolved',
      'Ana',
      'deleted',
      'Bo',
    ]);
  });
});

describe('panelView', () => {
  const docs = [
    doc('old-unread', 'ana@example.com', 0),
    doc('new-read', 'ana@example.com', 9),
    doc('mid-unread', 'ana@example.com', 5),
    doc('done', 'ana@example.com', 6, { resolved: true }),
    doc('elsewhere', 'ana@example.com', 7, { page: '/pricing' }),
  ];
  const seen = { 'new-read': at(10), done: at(10) };
  const state = { scope: 'page' as const, filter: 'open' as const, expanded: null };

  it('lists unread first, then newest', () => {
    expect(ids(panelView(threadsOf(docs, seen), state, here))).toEqual([
      'mid-unread',
      'old-unread',
      'new-read',
    ]);
  });

  it('counts each scope under the filter and each filter under the scope', () => {
    const view = panelView(threadsOf(docs, seen), state, here);
    expect(view.scopeCounts).toEqual({ page: 3, site: 4 });
    expect(view.filterCounts).toEqual({ unread: 2, open: 3, resolved: 1, deleted: 0 });
  });

  it('groups All pages by page with this page first', () => {
    const view = panelView(threadsOf(docs, seen), { ...state, scope: 'site' }, here);
    expect(view.groups.map((g) => [g.page, g.here, g.threads.length])).toEqual([
      ['', true, 3],
      ['/pricing', false, 1],
    ]);
  });

  it('keeps a thread with no page out of this page group', () => {
    const view = panelView(
      threadsOf([doc('a', ME, 0), doc('b', ME, 1, { page: '' })]),
      { ...state, scope: 'site' },
      here,
    );
    expect(view.groups.map((g) => [g.page, g.here])).toEqual([
      ['', true],
      ['', false],
    ]);
  });

  it('keeps the open thread in Unread, in place, after opening marks it read', () => {
    const opened = { ...seen, 'old-unread': at(11) };
    const expanded: Expanded = { id: 'old-unread', since: undefined, wasUnread: true };
    const view = panelView(threadsOf(docs, opened), { ...state, filter: 'unread', expanded }, here);
    expect(ids(view)).toEqual(['mid-unread', 'old-unread']);
    expect(ids(panelView(threadsOf(docs, opened), { ...state, filter: 'unread' }, here))).toEqual([
      'mid-unread',
    ]);
  });

  it('shows a thread I marked unread in Unread even when only I posted', () => {
    const view = panelView(
      threadsOf([doc('mine', ME, 0)], { mine: '' }),
      {
        ...state,
        filter: 'unread',
      },
      here,
    );
    expect(ids(view)).toEqual(['mine']);
  });
});

describe('filters and pins', () => {
  it('falls back to Open for a stored filter it does not know', () => {
    expect([parseFilter('all'), parseFilter(null), parseFilter('resolved')]).toEqual([
      'open',
      'open',
      'resolved',
    ]);
  });

  it('shows open pins under Unread and Open, resolved pins only under Resolved', () => {
    const [open, done] = threadsOf([doc('o', ME, 0), doc('r', ME, 1, { resolved: true })]);
    expect([pinShown(open!, 'unread'), pinShown(done!, 'unread')]).toEqual([true, false]);
    expect([pinShown(open!, 'resolved'), pinShown(done!, 'resolved')]).toEqual([false, true]);
  });
});

describe('isNewReply', () => {
  const reply = (email: string, minute: number) => ({
    id: 'r',
    author: '',
    email,
    text: '',
    createdAt: at(minute),
  });
  it('flags replies by others after my last visit, never mine or a first visit', () => {
    expect(isNewReply(reply('ana@example.com', 5), at(3), ME)).toBe(true);
    expect(isNewReply(reply('ana@example.com', 2), at(3), ME)).toBe(false);
    expect(isNewReply(reply(ME, 5), at(3), ME)).toBe(false);
    expect(isNewReply(reply('ana@example.com', 5), undefined, ME)).toBe(false);
  });
});
