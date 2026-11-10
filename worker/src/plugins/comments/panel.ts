import type { Point, Quote } from './anchor';
import { icon, type IconName } from './icons';
import {
  isNewReply,
  newReplyCount,
  REACTIONS,
  type Filter,
  type PageGroup,
  type Reaction,
  type PanelState,
  type PanelView,
  type Scope,
  type Thread,
} from './threads';

export const escapeHtml = (s: string) =>
  (s || '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

const ellipsis = (s: string, n: number) => {
  const cs = [...s];
  return cs.length > n ? `${cs.slice(0, n).join('').trimEnd()}…` : s;
};

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 2 * 86400) return 'Yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

const fullDate = (t: number) =>
  new Date(t).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });

export function timeHtml(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return `<time class="tm" datetime="${escapeHtml(iso)}" title="${escapeHtml(fullDate(t))}">${timeAgo(iso)}</time>`;
}

function initials(name: string): string {
  const words = name
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?')[0]!;
  return letters.toUpperCase();
}

const HUES = [262, 292, 330, 25, 55, 150, 185, 220];
function hueOf(key: string): number {
  let h = 0;
  for (const ch of key.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length]!;
}

const avatar = (name: string, key: string, draft = false) =>
  `<span class="av${draft ? ' draft' : ''}" style="--h:${hueOf(key || name)}" aria-hidden="true">${escapeHtml(initials(name))}</span>`;

export const quoteHtml = (q: Quote, lost: boolean, max: number) =>
  `<p class="q"><span>“${escapeHtml(ellipsis(q.exact, max))}”</span>${lost ? '<span class="lost"> · no longer on the page</span>' : ''}</p>`;

function spotWords(p: Point): string {
  const x = p.x < 0.34 ? 'left' : p.x > 0.66 ? 'right' : '';
  const y = p.y < 0.34 ? 'top' : p.y > 0.66 ? 'bottom' : '';
  return [y, x].filter(Boolean).join(' ') || 'center';
}

const TAG_WORDS: Record<string, string> = {
  div: 'Section',
  section: 'Section',
  p: 'Paragraph',
  a: 'Link',
  button: 'Button',
  img: 'Image',
  svg: 'Image',
  figure: 'Figure',
  input: 'Field',
  textarea: 'Field',
  select: 'Menu',
  ul: 'List',
  ol: 'List',
  li: 'List item',
  table: 'Table',
  tr: 'Table row',
  td: 'Table cell',
  th: 'Table cell',
  nav: 'Navigation',
  header: 'Header',
  footer: 'Footer',
  form: 'Form',
  article: 'Article',
  aside: 'Sidebar',
  main: 'Main content',
  span: 'Text',
  pre: 'Code block',
  blockquote: 'Quote',
  video: 'Video',
  details: 'Details',
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
};
const TAG_TOKEN = /^([a-z][a-z0-9]*)(?:#([\w-]+))?((?:\.[\w-]+)*)$/;

function tagInWords(token: string): string | null {
  const compact = token.replace(/\s*>\s*/g, '>');
  if (/\s/.test(compact)) return null;
  const last = compact
    .split('>')
    .pop()!
    .replace(/:nth-of-type\(\d+\)/g, '');
  const m = TAG_TOKEN.exec(last.startsWith('#') ? `div${last}` : last);
  const word = m && TAG_WORDS[m[1]!];
  if (!m || !word) return null;
  const ident = (m[2] || m[3]?.split('.').find(Boolean) || '').replace(/[-_]+/g, ' ');
  return ident ? `${word} “${ident}”` : word;
}

export function spotName(candidates: readonly (string | null | undefined)[]): string {
  for (const c of candidates) {
    const line = (c ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
    const name = line.replace(/\s+/g, ' ').trim();
    if (name) return ellipsis(tagInWords(name) ?? name, 40);
  }
  return '';
}

function spotLine(t: Thread, lost: boolean): string {
  const a = t.anchor;
  if (a.kind === 'page') return `<p class="spot">${icon('page')}<span>Whole page</span></p>`;
  if (lost)
    return `<p class="spot">${icon('target')}<span>Element is no longer on the page</span></p>`;
  const name = spotName([t.label, t.textSnippet, a.selector]);
  const where = a.point ? ` · ${spotWords(a.point)}` : '';
  return `<p class="spot">${icon('target')}<span>${escapeHtml(name)}${where}</span></p>`;
}

const anchorHtml = (t: Thread, lost: boolean, open: boolean) =>
  t.anchor.kind === 'text' ? quoteHtml(t.anchor.quote, lost, open ? 280 : 90) : spotLine(t, lost);

const btn = (act: string, label: string, opts: { icon?: IconName; cls?: string } = {}) =>
  `<button class="btn sm ${opts.cls ?? ''}" data-act="${act}">${opts.icon ? icon(opts.icon) : ''}${label}</button>`;
const ib = (act: string, label: string, name: IconName) =>
  `<button class="ib" data-act="${act}" aria-label="${label}" data-tip="${label}">${icon(name)}</button>`;

export const emojiRowHtml = () =>
  REACTIONS.map(
    (e) =>
      `<button class="emo" data-act="emoji" data-v="${e}" aria-label="React with ${e}">${e}</button>`,
  ).join('');

export const quickBarHtml = (step: 'actions' | 'emoji') =>
  step === 'emoji'
    ? emojiRowHtml()
    : `${ib('sel-comment', 'Add comment', 'comment')}${ib('sel-react', 'Add reaction', 'smile')}`;

const sameEmail = (a: string, b: string) =>
  !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

function reactionsHtml(rs: readonly Reaction[], to: string, o: ThreadOpts, live: boolean): string {
  const chips = rs.map((r) => {
    const names = r.by
      .map((p) => (sameEmail(p.email, o.me) ? 'You' : p.name || p.email))
      .join(', ');
    const act = live
      ? ` data-act="react" data-v="${r.emoji}" data-to="${escapeHtml(to)}" aria-pressed="${!!r.mine}"`
      : ' disabled';
    return `<button class="rc${r.mine ? ' on' : ''}"${act} data-tip="${escapeHtml(names)}" aria-label="${escapeHtml(`${r.emoji} ${r.by.length}: ${names}`)}"><span class="e">${r.emoji}</span>${r.by.length}</button>`;
  });
  const add =
    live && o.open
      ? `<button class="ib add-rx" data-act="react-menu" data-to="${escapeHtml(to)}" aria-label="Add reaction" data-tip="Add reaction">${icon('smile')}</button>`
      : '';
  return chips.length || add ? `<div class="rxs">${chips.join('')}${add}</div>` : '';
}

export interface ThreadOpts {
  open: boolean;
  armed: boolean;
  since: string | undefined;
  lost: boolean;
  me: string;
  surface: 'panel' | 'pop';
  elsewhere: string;
  /** The thread's site when it is not the top page's, else ''. Numbers are per site. */
  site: string;
}

function quickTools(t: Thread): string {
  if (t.kind === 'draft') return `<div class="tools">${ib('publish', 'Publish', 'publish')}</div>`;
  if (t.status === 'deleted') return '';
  const status =
    t.status === 'resolved' ? ib('reopen', 'Reopen', 'reopen') : ib('resolve', 'Resolve', 'check');
  const read = t.unread ? ib('read', 'Mark read', 'read') : ib('unread', 'Mark unread', 'unread');
  return `<div class="tools">${status}${read}</div>`;
}

function statusTag(t: Thread): string {
  if (t.kind === 'draft') return '<span class="tag">Draft</span>';
  if (t.status === 'resolved') return '<span class="tag st">Resolved</span>';
  if (t.status === 'deleted') return '<span class="tag st">Deleted</span>';
  return '';
}

function collapsedMeta(t: Thread, o: ThreadOpts): string {
  if (t.kind === 'draft') {
    const where = o.elsewhere
      ? `On ${escapeHtml(o.elsewhere)}, not published`
      : 'Only in your browser, not published';
    return `<div class="meta"><span>${where}</span>${btn('publish', 'Publish', { cls: 'pri' })}</div>`;
  }
  const me = o.me;
  const parts: string[] = [];
  const n = t.replies.length;
  if (n) parts.push(`${icon('reply')}<span>${n} ${n === 1 ? 'reply' : 'replies'}</span>`);
  const fresh = newReplyCount(t, me);
  if (fresh) parts.push(`<span class="fresh">${fresh} new</span>`);
  if (t.statusBy)
    parts.push(
      `<span>${t.status === 'deleted' ? 'Deleted' : 'Resolved'} by ${escapeHtml(t.statusBy)}</span>`,
    );
  return parts.length
    ? `<p class="meta">${parts.join('<span aria-hidden="true">·</span>')}</p>`
    : '';
}

const reactable = (t: Thread) => t.kind === 'published' && t.status !== 'deleted';

function repliesHtml(t: Thread, o: ThreadOpts): string {
  return t.replies
    .map(
      (r) =>
        `<div class="rp"><div class="row">${avatar(r.author || r.email, r.email)}<span class="nm" title="${escapeHtml(r.email)}">${escapeHtml(r.author || r.email)}</span>${timeHtml(r.createdAt)}${isNewReply(r, o.since, o.me) ? '<span class="new">New</span>' : ''}</div><p class="tx">${escapeHtml(r.text)}</p>${reactionsHtml(r.reactions, r.id, o, reactable(t))}</div>`,
    )
    .join('');
}

function openFooter(t: Thread, o: ThreadOpts): string {
  if (o.armed) {
    const ask =
      t.kind === 'draft'
        ? 'Discard this draft? It was never published.'
        : 'Delete this thread for everyone?';
    return `<div class="confirm" role="alert"><span>${ask}</span>${btn('disarm', 'Cancel', { cls: 'ghost' })}${btn('confirm-delete', t.kind === 'draft' ? 'Discard' : 'Delete', { cls: 'danger' })}</div>`;
  }
  if (t.kind === 'draft')
    return `<div class="acts">${btn('publish', 'Publish', { cls: 'pri', icon: 'publish' })}${btn('save-draft', 'Save')}${btn('delete', 'Discard', { cls: 'ghost push', icon: 'trash' })}</div>`;
  if (t.status === 'deleted') return '';
  const reply = `<div class="inp"><textarea rows="1" placeholder="Reply…" aria-label="Reply" data-reply="${escapeHtml(t.id)}" data-keep="reply:${escapeHtml(t.id)}"></textarea><button class="send" data-act="reply" aria-label="Send reply" title="Send (⌘↵)" disabled>${icon('send')}</button></div>`;
  const status =
    t.status === 'resolved'
      ? btn('reopen', 'Reopen', { icon: 'reopen' })
      : btn('resolve', 'Resolve', { icon: 'check' });
  return `${reply}<div class="acts">${status}${btn('unread', 'Mark unread', { cls: 'ghost', icon: 'unread' })}${btn('delete', 'Delete', { cls: 'ghost push', icon: 'trash' })}</div>`;
}

export function threadHtml(t: Thread, o: ThreadOpts): string {
  const id = escapeHtml(t.id);
  const cls = [
    'th',
    t.unread ? '' : 'read',
    o.open ? 'open' : '',
    t.kind === 'draft' ? 'draft' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const toggle = o.surface === 'pop' ? '' : o.open ? ' data-act="collapse" title="Collapse"' : '';
  const rowAttrs =
    o.surface === 'panel' && !o.open
      ? ` data-act="expand" tabindex="0" role="button" aria-expanded="false" aria-label="${escapeHtml(`${t.unread ? 'Unread. ' : ''}${t.author}${t.reaction ? ` reacted ${t.reaction}` : `: ${ellipsis(t.text, 80)}`}`)}"`
      : '';
  const head = `<div class="row"${toggle}>${avatar(t.author || t.email, t.email, t.kind === 'draft')}<span class="nm" title="${escapeHtml(t.email)}">${escapeHtml(t.author || t.email)}</span>${statusTag(t)}${timeHtml(t.createdAt)}<span class="num">${o.site ? `${escapeHtml(o.site)} ` : ''}#${t.num}</span>${t.unread ? '<span class="dot" role="img" aria-label="Unread"></span>' : ''}</div>`;
  const said = t.reaction
    ? `<div class="rxq"><span class="rxe" role="img" aria-label="Reacted ${t.reaction}">${t.reaction}</span>${anchorHtml(t, o.lost, o.open)}</div>`
    : anchorHtml(t, o.lost, o.open) +
      (t.kind === 'draft' && o.open
        ? `<div class="field"><textarea data-draft="${id}" data-keep="draft:${id}" aria-label="Edit draft"></textarea></div>`
        : `<p class="tx">${escapeHtml(t.text)}</p>`);
  const body = `<div class="bd">${said}${reactionsHtml(t.reactions, t.id, o, reactable(t))}${o.open ? '' : collapsedMeta(t, o)}</div>`;
  const tools = o.surface === 'panel' && !o.open ? quickTools(t) : '';
  const open = o.open ? `${repliesHtml(t, o)}${openFooter(t, o)}` : '';
  return `<article class="${cls}" data-id="${id}"${rowAttrs}>${tools}${head}${body}${open}</article>`;
}

const FILTER_LABEL: Record<Filter, string> = {
  unread: 'Unread',
  open: 'Open',
  resolved: 'Resolved',
  deleted: 'Deleted',
};

function emptyHtml(filter: Filter, scope: Scope): string {
  const where = scope === 'page' ? 'on this page' : 'on this site';
  const [title, body, name]: [string, string, IconName] =
    filter === 'unread'
      ? ["You're all caught up", `No unread threads ${where}.`, 'check']
      : filter === 'open'
        ? ['No open comments', 'Select text or click anything on the page to leave one.', 'comment']
        : [`No ${filter} comments`, `Nothing ${filter} ${where} yet.`, 'comment'];
  return `<div class="empty"><div class="ring">${icon(name)}</div><strong>${title}</strong>${body}</div>`;
}

const hiddenUnreadHtml = (hidden: PanelView['hiddenUnread']) =>
  hidden
    .map(
      (h) =>
        `<button class="hidden-unread" data-act="filter" data-v="${h.status}"><span class="dot" aria-hidden="true"></span><span>${h.count} unread in ${FILTER_LABEL[h.status]}</span>${icon('arrow')}</button>`,
    )
    .join('');

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The ⋯ menu's header line. Drafts carry status `open` but are not on the server yet. */
export function menuHead(site: string, threads: readonly Thread[]): string {
  const posted = threads.filter((t) => t.kind === 'published');
  const open = posted.filter((t) => t.status === 'open').length;
  const unread = posted.filter((t) => t.unread).length;
  return `${site} · ${open} open · ${unread} unread · ${plural(threads.length - posted.length, 'draft')}`;
}

function footerHtml(drafts: number): string {
  const copyAll = `<button class="btn sm ghost" data-act="copy-all" title="Copy every comment as Markdown for an agent">${icon('copy')}Copy all</button>`;
  if (!drafts) return `<div class="ft">${copyAll}</div>`;
  return `<div class="ft">${copyAll}<span class="ft-n">${plural(drafts, 'draft')}</span>${btn('copy-drafts', 'Copy', { cls: 'ghost' })}${btn('publish-all', 'Publish all', { cls: 'pri', icon: 'publish' })}</div>`;
}

const pageName = (page: string) => {
  const path = page.split('?')[0]!;
  return path.endsWith('/') ? page : page.slice(path.lastIndexOf('/') + 1);
};

function groupHead(g: PageGroup, site: string): string {
  const where = g.site === site ? '' : `${g.site} · `;
  const label = (text: string) =>
    `<div class="grp">${icon('page')}<span>${escapeHtml(text)}</span></div>`;
  if (g.rank === 0) return label('This page');
  if (g.rank > 0) return label(where + pageName(g.page));
  if (!g.page) return label('No page');
  return `<button class="grp" data-act="goto-page" data-v="${escapeHtml(g.page)}" title="Go to ${escapeHtml(g.page)}">${icon('page')}<span>${escapeHtml(where + g.page)}</span>${icon('arrow')}</button>`;
}

export function panelHtml(
  view: PanelView,
  state: PanelState,
  ctx: { site: string; picking: boolean; drafts: number; thread: (t: Thread) => ThreadOpts },
): string {
  const tab = (s: Scope, label: string) =>
    `<button class="tab${state.scope === s ? ' on' : ''}" role="tab" aria-selected="${state.scope === s}" data-act="scope" data-v="${s}">${label} <span class="n">${view.scopeCounts[s]}</span></button>`;
  const chip = (f: Filter) =>
    `<button class="chip${state.filter === f ? ' on' : ''}" aria-pressed="${state.filter === f}" data-act="filter" data-v="${f}">${FILTER_LABEL[f]} <span class="n">${view.filterCounts[f]}</span></button>`;
  const archived: Filter = state.filter === 'deleted' ? 'deleted' : 'resolved';
  const statOn = state.filter === 'resolved' || state.filter === 'deleted';
  const drafts = view.drafts.length
    ? `<div class="grp">${icon('comment')}<span>Your drafts</span><span class="n">${view.drafts.length}</span></div>${view.drafts.map((t) => threadHtml(t, ctx.thread(t))).join('')}`
    : '';
  const headed = state.scope === 'site' || view.groups.length > 1;
  const list = view.groups.length
    ? view.groups
        .map((g) => {
          const head = headed
            ? groupHead(g, ctx.site)
            : drafts
              ? `<div class="grp"><span>${FILTER_LABEL[state.filter]}</span></div>`
              : '';
          return head + g.threads.map((t) => threadHtml(t, ctx.thread(t))).join('');
        })
        .join('')
    : emptyHtml(state.filter, state.scope);
  const hidden = hiddenUnreadHtml(view.hiddenUnread);
  return `<header class="hd"><h2>Comments</h2><span class="site" title="${escapeHtml(ctx.site)}">${escapeHtml(ctx.site)}</span>${ib('more-menu', 'More', 'more')}${ib('close', 'Close', 'x')}</header>
<div class="act">${
    ctx.picking
      ? `<button class="btn" data-act="pick">Cancel</button><span class="hint">Click the page to place it · Esc</span>`
      : `<button class="btn pri" data-act="pick">${icon('plus')}Comment</button><span class="hint">Select text, then click</span>`
  }</div>
<div class="tabs" role="tablist">${tab('page', 'This page')}${tab('site', 'All pages')}</div>
<div class="flt">${chip('unread')}${chip('open')}<button class="stat${statOn ? ' on' : ''}" data-act="status-menu" aria-haspopup="menu">${FILTER_LABEL[archived]} ${view.filterCounts[archived]}${icon('chev')}</button></div>
<div class="list">${drafts}${list}${hidden}</div>
${footerHtml(ctx.drafts)}`;
}

export type MenuItem =
  | 'sep'
  | {
      act: string;
      label: string;
      icon?: IconName;
      k?: string;
      v?: string;
      on?: boolean;
      armed?: boolean;
    };

export const menuHtml = (items: readonly MenuItem[], head?: string) =>
  (head ? `<div class="mhead">${escapeHtml(head)}</div>` : '') +
  items
    .map((m) =>
      m === 'sep'
        ? '<div class="msep"></div>'
        : `<button class="mi${m.on ? ' on' : ''}${m.armed ? ' armed' : ''}" role="menuitem" data-act="${m.act}"${m.v ? ` data-v="${escapeHtml(m.v)}"` : ''}>${m.icon ? icon(m.icon) : ''}<span>${escapeHtml(m.label)}</span>${m.k ? `<span class="k">${escapeHtml(m.k)}</span>` : ''}</button>`,
    )
    .join('');
