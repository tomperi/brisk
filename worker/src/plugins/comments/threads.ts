import { anchorLines, anchorOfRecord, type Anchor, type AnchorFields } from './anchor';
import { isUnread } from './inbox';

export type Status = 'open' | 'resolved' | 'deleted';
export type Filter = 'unread' | Status;
export type Scope = 'page' | 'site';
export const FILTERS: readonly Filter[] = ['unread', 'open', 'resolved', 'deleted'];

export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅', '❓', '🔥'] as const;
export type Emoji = (typeof REACTIONS)[number];
export const parseEmoji = (raw: unknown): Emoji | null =>
  (REACTIONS as readonly unknown[]).includes(raw) ? (raw as Emoji) : null;

export interface Person {
  name: string;
  email: string;
}

export interface Reaction {
  emoji: Emoji;
  by: Person[];
  mine: string | null;
}

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
  reactions: Reaction[];
}

export interface Thread {
  id: string;
  /** The site that stores the thread: every write about it goes there. */
  site: string;
  kind: 'draft' | 'published';
  page: string;
  anchor: Anchor;
  label: string;
  textSnippet: string;
  status: Status;
  statusBy: string;
  author: string;
  email: string;
  text: string;
  reaction: Emoji | null;
  createdAt: string;
  activityAt: string;
  replies: Reply[];
  reactions: Reaction[];
  unread: boolean;
  seenAt: string | undefined;
  /** 1..n within `site`, the number `brisk plugin comments export <site>` prints. */
  num: number;
}

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
const lower = (s: string) => s.trim().toLowerCase();

function groupReactions(docs: readonly StoredDoc[], me: string): Reaction[] {
  const out: Reaction[] = [];
  for (const d of docs) {
    const emoji = parseEmoji(d.reaction);
    if (!emoji) continue;
    const person = { name: str(d.createdBy), email: str(d.createdByEmail) };
    const who = lower(person.email || person.name);
    let r = out.find((x) => x.emoji === emoji);
    if (!r) out.push((r = { emoji, by: [], mine: null }));
    if (!r.by.some((p) => lower(p.email || p.name) === who)) r.by.push(person);
    if (me && lower(person.email) === lower(me)) r.mine ??= d.id;
  }
  return out;
}

export function buildThreads(input: {
  site: string;
  drafts: readonly Draft[];
  docs: readonly StoredDoc[];
  seen: Readonly<Record<string, string>>;
  me: string;
}): Thread[] {
  const { site, drafts, docs, seen, me } = input;
  const children = new Map<string, StoredDoc[]>();
  for (const d of docs) {
    const parent = str(d.parentId);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), d]);
  }
  const threads: Thread[] = [
    ...drafts.map((d) => ({
      id: d.id,
      site,
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
      reaction: null,
      createdAt: d.createdAt,
      activityAt: d.createdAt,
      replies: [],
      reactions: [],
      unread: false,
      seenAt: undefined,
      num: 0,
    })),
    ...docs
      .filter((d) => !str(d.parentId))
      .map((d) => {
        const kids = (children.get(d.id) ?? []).sort((a, b) =>
          a.createdAt < b.createdAt ? -1 : 1,
        );
        const own = kids.filter((k) => !k.reaction);
        const reactionDocs = kids.filter((k) => k.reaction && !k.deleted);
        const reactionsOn = (target: string) =>
          groupReactions(
            reactionDocs.filter((k) => (str(k.reactTo) || d.id) === target),
            me,
          );
        const status = statusOf(d);
        return {
          id: d.id,
          site,
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
          reaction: parseEmoji(d.reaction),
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
              reactions: reactionsOn(r.id),
            })),
          reactions: reactionsOn(d.id),
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

const unreadInList = (t: Thread, expanded: Expanded | null) =>
  t.unread || (expanded?.id === t.id && expanded.wasUnread);

export const matches = (t: Thread, filter: Filter, expanded: Expanded | null): boolean =>
  filter === 'unread' ? t.status !== 'deleted' && unreadInList(t, expanded) : t.status === filter;

export const pinShown = (t: Thread, filter: Filter): boolean =>
  t.kind === 'draft' ||
  (filter === 'unread' || filter === 'open' ? t.status === 'open' : t.status === filter);

export interface PageGroup {
  site: string;
  page: string;
  /** Where the page is on screen: 0 the top page, 1+ a frame, -1 not shown. */
  rank: number;
  threads: Thread[];
}

export interface PanelView {
  drafts: Thread[];
  groups: PageGroup[];
  scopeCounts: Record<Scope, number>;
  filterCounts: Record<Filter, number>;
  hiddenUnread: { status: Status; count: number }[];
}

export type RankOf = (t: Pick<Thread, 'site' | 'page'>) => number;

export function panelView(
  threads: readonly Thread[],
  state: Pick<PanelState, 'scope' | 'filter' | 'expanded'>,
  rankOf: RankOf,
): PanelView {
  const { scope, filter, expanded } = state;
  const inScope = (t: Thread, s: Scope) => s === 'site' || rankOf(t) >= 0;
  const posted = threads.filter((t) => t.kind === 'published');
  const count = (pred: (t: Thread) => boolean) => posted.filter(pred).length;
  const shown = posted
    .filter((t) => inScope(t, scope) && matches(t, filter, expanded))
    .sort(
      (a, b) =>
        Number(unreadInList(b, expanded)) - Number(unreadInList(a, expanded)) ||
        Date.parse(b.activityAt) - Date.parse(a.activityAt),
    );
  const byPage = new Map<string, PageGroup>();
  for (const t of shown) {
    const rank = rankOf(t);
    // By rank, so a bare-path comment and a ?query one on the same shown page share a group.
    const key = rank >= 0 ? `rank:${rank}` : `${t.site}\n${t.page}`;
    const group = byPage.get(key) ?? { site: t.site, page: t.page, rank, threads: [] };
    group.threads.push(t);
    byPage.set(key, group);
  }
  const order = (g: PageGroup) => (g.rank < 0 ? Number.MAX_SAFE_INTEGER : g.rank);
  const groups = [...byPage.values()].sort((a, b) => order(a) - order(b));
  return {
    drafts: threads
      .filter((t) => t.kind === 'draft' && inScope(t, scope))
      .sort((a, b) => a.num - b.num),
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

export const isNewReply = (r: Reply, since: string | undefined, me: string): boolean =>
  !!since &&
  r.email.trim().toLowerCase() !== me.trim().toLowerCase() &&
  Date.parse(r.createdAt) > Date.parse(since);

export const newReplyCount = (t: Thread, me: string): number =>
  t.unread ? t.replies.filter((r) => isNewReply(r, t.seenAt, me)).length : 0;

const names = (by: readonly Person[]) => by.map((p) => p.name || p.email).join(', ');

export const reactionsText = (rs: readonly Reaction[]): string =>
  rs.map((r) => `${r.emoji} ×${r.by.length} (${names(r.by)})`).join(', ');

export function threadMarkdown(t: Thread): string {
  const status = t.kind === 'draft' ? 'draft' : t.status;
  const id = t.kind === 'draft' ? '' : `[${t.id}] `;
  const lines = [
    `## #${t.num} ${id}(${status}) ${t.reaction ? `${t.reaction} reaction` : t.text}`,
    `- page: \`${t.page}\``,
    ...anchorLines(t.anchor),
  ];
  if (t.textSnippet) lines.push(`- text: "${t.textSnippet}"`);
  lines.push(`- by: ${t.author}`);
  if (t.reactions.length) lines.push(`- reactions: ${reactionsText(t.reactions)}`);
  for (const r of t.replies) {
    lines.push(`- reply (${r.author}): ${r.text}`);
    if (r.reactions.length) lines.push(`  - reactions: ${reactionsText(r.reactions)}`);
  }
  return lines.join('\n');
}
