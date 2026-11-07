import { anchorOfRecord, type Anchor, type AnchorFields } from './anchor';
import { isUnread } from './inbox';

export type Status = 'open' | 'resolved' | 'deleted';
export type Filter = 'unread' | Status;
export type Scope = 'page' | 'site';
export const FILTERS: readonly Filter[] = ['unread', 'open', 'resolved', 'deleted'];

/** A comment that lives only in this browser until it is published. */
export type Draft = AnchorFields & {
  id: string;
  text: string;
  page: string;
  label: string;
  textSnippet: string;
  html: string;
  /** The element's data-* attributes, often the fastest grep for an agent. */
  dataAttrs?: string;
  createdAt: string;
};

export interface StoredDoc {
  id: string;
  createdAt: string;
  [k: string]: unknown;
}

export interface Reply {
  id: string;
  author: string;
  email: string;
  text: string;
  createdAt: string;
}

export interface Thread {
  id: string;
  kind: 'draft' | 'published';
  page: string;
  anchor: Anchor;
  label: string;
  textSnippet: string;
  status: Status;
  /** Who resolved or deleted it, when it is not open. */
  statusBy: string;
  author: string;
  email: string;
  text: string;
  createdAt: string;
  /** The newest of the comment and its replies. */
  activityAt: string;
  replies: Reply[];
  unread: boolean;
  seenAt: string | undefined;
  /** One sequence per site: published threads count 1..n by creation, so a
   *  published number never changes; drafts continue after them. */
  num: number;
}

/** The thread open in the panel, with what it looked like before opening it
 *  marked it read: the list keeps it in place and its new replies stay marked. */
export interface Expanded {
  id: string;
  since: string | undefined;
  wasUnread: boolean;
}

export interface PanelState {
  open: boolean;
  scope: Scope;
  filter: Filter;
  expanded: Expanded | null;
}

export const parseScope = (raw: string | null): Scope => (raw === 'site' ? 'site' : 'page');
export const parseFilter = (raw: string | null): Filter =>
  (FILTERS as readonly (string | null)[]).includes(raw) ? (raw as Filter) : 'open';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const later = (a: string, b: string) => (Date.parse(b) > Date.parse(a) ? b : a);
const statusOf = (d: StoredDoc): Status =>
  d.deleted ? 'deleted' : d.resolved ? 'resolved' : 'open';

export function buildThreads(input: {
  drafts: readonly Draft[];
  docs: readonly StoredDoc[];
  seen: Readonly<Record<string, string>>;
  me: string;
}): Thread[] {
  const { drafts, docs, seen, me } = input;
  const replies = new Map<string, StoredDoc[]>();
  for (const d of docs) {
    const parent = str(d.parentId);
    if (parent) replies.set(parent, [...(replies.get(parent) ?? []), d]);
  }
  const threads: Thread[] = [
    ...drafts.map((d) => ({
      id: d.id,
      kind: 'draft' as const,
      page: d.page,
      anchor: anchorOfRecord(d),
      label: d.label,
      textSnippet: d.textSnippet,
      status: 'open' as const,
      statusBy: '',
      author: 'You',
      email: me,
      text: d.text,
      createdAt: d.createdAt,
      activityAt: d.createdAt,
      replies: [],
      unread: false,
      seenAt: undefined,
      num: 0,
    })),
    ...docs
      .filter((d) => !str(d.parentId))
      .map((d) => {
        const own = (replies.get(d.id) ?? []).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        const status = statusOf(d);
        return {
          id: d.id,
          kind: 'published' as const,
          page: str(d.page),
          anchor: anchorOfRecord(d),
          label: str(d.label),
          textSnippet: str(d.textSnippet),
          status,
          statusBy:
            status === 'deleted'
              ? str(d.deletedBy)
              : status === 'resolved'
                ? str(d.resolvedBy)
                : '',
          author: str(d.createdBy),
          email: str(d.createdByEmail),
          text: str(d.text),
          createdAt: d.createdAt,
          activityAt: own
            .filter((r) => !r.deleted)
            .reduce((at, r) => later(at, r.createdAt), d.createdAt),
          replies: own
            .filter((r) => !r.deleted)
            .map((r) => ({
              id: r.id,
              author: str(r.createdBy),
              email: str(r.createdByEmail),
              text: str(r.text),
              createdAt: r.createdAt,
            })),
          unread: status !== 'deleted' && isUnread(d, own, me, seen[d.id]),
          seenAt: seen[d.id],
          num: 0,
        };
      }),
  ];
  const byCreation = (a: Thread, b: Thread) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
  const ordered = [
    ...threads.filter((t) => t.kind === 'published').sort(byCreation),
    ...threads.filter((t) => t.kind === 'draft').sort(byCreation),
  ];
  ordered.forEach((t, i) => (t.num = i + 1));
  return threads;
}

/** The open thread keeps the unread state it had when it was opened. */
const unreadInList = (t: Thread, expanded: Expanded | null) =>
  t.unread || (expanded?.id === t.id && expanded.wasUnread);

export const matches = (t: Thread, filter: Filter, expanded: Expanded | null): boolean =>
  filter === 'unread' ? t.status !== 'deleted' && unreadInList(t, expanded) : t.status === filter;

/** Unread and Open both show the open pins; Resolved and Deleted show theirs. */
export const pinShown = (t: Thread, filter: Filter): boolean =>
  filter === 'unread' || filter === 'open' ? t.status === 'open' : t.status === filter;

export interface PageGroup {
  page: string;
  here: boolean;
  threads: Thread[];
}

export interface PanelView {
  groups: PageGroup[];
  scopeCounts: Record<Scope, number>;
  filterCounts: Record<Filter, number>;
  /** Unread threads in scope that the active filter does not list, by status. */
  hiddenUnread: { status: Status; count: number }[];
}

/** Unread first, then the newest activity; on All pages this page's group
 *  leads and the others follow in the order of their first thread. */
export function panelView(
  threads: readonly Thread[],
  state: Pick<PanelState, 'scope' | 'filter' | 'expanded'>,
  isHere: (page: string) => boolean,
): PanelView {
  const { scope, filter, expanded } = state;
  const inScope = (t: Thread, s: Scope) => s === 'site' || isHere(t.page);
  const count = (pred: (t: Thread) => boolean) => threads.filter(pred).length;
  const shown = threads
    .filter((t) => inScope(t, scope) && matches(t, filter, expanded))
    .sort(
      (a, b) =>
        Number(unreadInList(b, expanded)) - Number(unreadInList(a, expanded)) ||
        Date.parse(b.activityAt) - Date.parse(a.activityAt),
    );
  const byPage = new Map<string, PageGroup>();
  for (const t of shown) {
    const here = scope === 'page' || isHere(t.page);
    const key = here ? '\0here' : t.page;
    const group = byPage.get(key) ?? { page: here ? '' : t.page, here, threads: [] };
    group.threads.push(t);
    byPage.set(key, group);
  }
  const groups = [...byPage.values()].sort((a, b) => Number(b.here) - Number(a.here));
  return {
    groups,
    scopeCounts: {
      page: count((t) => inScope(t, 'page') && matches(t, filter, expanded)),
      site: count((t) => matches(t, filter, expanded)),
    },
    filterCounts: Object.fromEntries(
      FILTERS.map((f) => [f, count((t) => inScope(t, scope) && matches(t, f, expanded))]),
    ) as Record<Filter, number>,
    hiddenUnread:
      filter === 'unread'
        ? []
        : (['open', 'resolved'] as const)
            .filter((s) => s !== filter)
            .map((status) => ({
              status,
              count: count(
                (t) => inScope(t, scope) && t.status === status && unreadInList(t, expanded),
              ),
            }))
            .filter((h) => h.count > 0),
  };
}

/** A reply someone else wrote after I last opened the thread. */
export const isNewReply = (r: Reply, since: string | undefined, me: string): boolean =>
  !!since &&
  r.email.trim().toLowerCase() !== me.trim().toLowerCase() &&
  Date.parse(r.createdAt) > Date.parse(since);

export const newReplyCount = (t: Thread, me: string): number =>
  t.unread ? t.replies.filter((r) => isNewReply(r, t.seenAt, me)).length : 0;
