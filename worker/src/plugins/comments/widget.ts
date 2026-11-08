/* Brisk comments widget. Injected into pages that enable the comments plugin.
 * Drafts live in localStorage (local-first); publishing promotes them to
 * brisk.db via the plugin's server actions, which stamp the author and append
 * an audit event. Reads use the SDK when the page loads /brisk.js and fall
 * back to the same fetch the write path uses when it doesn't — only realtime
 * needs the SDK (without it the data refreshes after each of our own actions). */
import {
  anchorFields,
  anchorLines,
  anchorOfRecord,
  captureQuote,
  flatten,
  locateQuote,
  SCAN_MAX,
  type Anchor,
  type FlatText,
  type Quote,
} from './anchor';
import { icon } from './icons';
import { seenDocId } from './inbox';
import {
  escapeHtml,
  menuHtml,
  panelHtml,
  quickBarHtml,
  quoteHtml,
  spotName,
  threadHtml,
  type MenuItem,
} from './panel';
import { DOCK_MIN, HIGHLIGHT_CSS, PANEL_W, WIDGET_CSS } from './styles';
import {
  buildThreads,
  matches,
  panelView,
  parseEmoji,
  parseFilter,
  parseScope,
  pinShown,
  threadMarkdown,
  type Draft,
  type Emoji,
  type Filter,
  type PanelState,
  type StoredDoc,
  type Thread,
} from './threads';

type Handlers = {
  onCreate?: (d: StoredDoc) => void;
  onUpdate?: (d: StoredDoc) => void;
  onDelete?: (id: string) => void;
};
type Brisk = {
  db: {
    collection(name: string): {
      list(opts?: { limit?: number; sort?: string }): Promise<StoredDoc[]>;
      subscribe(h: Handlers): () => void;
    };
  };
};

(() => {
  const tag = document.querySelector<HTMLScriptElement>('script[data-brisk-plugin="comments"]');
  const SITE = tag?.dataset.briskSite ?? '';
  const marker = window as { __briskComments?: boolean };
  if (marker.__briskComments) return;
  marker.__briskComments = true;

  // The SDK is optional: without /brisk.js the widget reads over plain fetch
  // and skips realtime — drafts, publishing, and published views all still work.
  const sdk = (window as { brisk?: Brisk }).brisk;

  const COLLECTION = '_plugin:comments';
  const SEEN = '_plugin:comments:seen';
  const key = (k: string) => `brisk:comments:${SITE}:${k}`;
  const recall = (k: string) => localStorage.getItem(key(k));
  const remember = (k: string, v: string) => localStorage.setItem(key(k), v);
  const clean = (s: string, n: number) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  const loadDrafts = (): Draft[] => {
    try {
      return JSON.parse(recall('drafts') || '[]') as Draft[];
    } catch {
      return [];
    }
  };
  let drafts = loadDrafts();
  const saveDrafts = () => remember('drafts', JSON.stringify(drafts));

  let hidden = recall('hidden') === '1';
  let collapsed = recall('collapsed') === '1';
  /** Hides the pins only — independent of collapsing the toolbar. */
  let pinsHidden = recall('pins') === '1';
  const panel: PanelState = {
    open: recall('panel') === '1',
    scope: parseScope(recall('scope')),
    filter: parseFilter(recall('filter')),
    expanded: null,
  };
  let armed: string | null = null;
  let popThread: { id: string; since: string | undefined } | null = null;
  const buffers = new Map<string, string>();

  let published: StoredDoc[] = [];
  let me = { email: '', name: '' };
  let serverSeen: Record<string, string> = {};
  const pendingSeen = new Map<string, string>();
  let seenReady = false;
  let threads: Thread[] = [];
  const threadById = (id: string | undefined) => threads.find((t) => t.id === id);

  const refreshPublished = async () => {
    if (sdk) {
      published = await sdk.db.collection(COLLECTION).list({ limit: 500, sort: '-created' });
    } else {
      const res = await fetch(`/api/db/${COLLECTION}?limit=500&sort=-created`, {
        headers: { 'x-brisk-site': SITE },
      });
      if (!res.ok) return;
      published = ((await res.json()) as { docs: StoredDoc[] }).docs;
    }
    render();
  };

  const myDocId = () => seenDocId(me.email);
  const applySeen = (doc: StoredDoc) => {
    if (doc.id !== myDocId()) return;
    serverSeen = { ...(doc.seen as Record<string, string> | undefined) };
    render();
  };
  if (sdk) {
    sdk.db.collection(COLLECTION).subscribe({
      onCreate: (d) => {
        published = [d, ...published.filter((p) => p.id !== d.id)];
        render();
      },
      onUpdate: (d) => {
        published = published.map((p) => (p.id === d.id ? d : p));
        render();
      },
      onDelete: (id) => {
        published = published.filter((p) => p.id !== id);
        render();
      },
    });
    sdk.db.collection(SEEN).subscribe({ onCreate: applySeen, onUpdate: applySeen });
  }

  const action = async (name: string, args: Record<string, string>): Promise<StoredDoc> => {
    const res = await fetch(`/api/plugins/comments/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { site: SITE, ...args } }),
    });
    if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
    // With realtime unavailable, our own mutations won't push back — re-read.
    if (!sdk && name !== 'seen' && name !== 'unseen') void refreshPublished();
    return ((await res.json()) as { result: StoredDoc }).result;
  };

  void fetch('/api/me')
    .then((r) => (r.ok ? (r.json() as Promise<{ email?: string; name?: string }>) : null))
    .then(async (who) => {
      if (!who?.email) throw new Error('/api/me refused');
      me = { email: who.email, name: who.name ?? '' };
      const res = await fetch(`/api/db/${SEEN}/${encodeURIComponent(myDocId())}`, {
        headers: { 'x-brisk-site': SITE },
      });
      if (!res.ok && res.status !== 404) throw new Error(`seen state: ${res.status}`);
      serverSeen = res.ok
        ? { ...((await res.json()) as { seen?: Record<string, string> }).seen }
        : {};
      seenReady = true;
      render();
    })
    .catch((err: unknown) => console.warn('[comments] unread state unavailable:', err));

  async function writeSeen(id: string, stamp: string) {
    const t = threadById(id);
    if (!t || t.kind === 'draft' || !seenReady) return;
    if (pendingSeen.get(id) === stamp) return;
    pendingSeen.set(id, stamp);
    render();
    try {
      const doc = await action(stamp ? 'seen' : 'unseen', { id });
      if (pendingSeen.get(id) === stamp) pendingSeen.delete(id);
      applySeen(doc);
    } catch {
      if (pendingSeen.get(id) === stamp) pendingSeen.delete(id);
      render();
      toast(stamp ? 'Could not mark it read' : 'Could not mark it unread');
    }
  }
  const markRead = (id: string) => void writeSeen(id, new Date().toISOString());
  const markUnread = (id: string) => {
    if (panel.expanded?.id === id) panel.expanded = null;
    if (popThread?.id === id) closePop();
    void writeSeen(id, '');
  };

  // ---- element anchoring (ported from html-grab) ---------------------------
  function cssPath(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let sel = node.nodeName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.nodeName === node!.nodeName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = parent;
    }
    return parts.join(' > ');
  }
  const labelOf = (el: Element) =>
    `${el.nodeName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList]
      .slice(0, 2)
      .map((c) => `.${c}`)
      .join('')}`;
  const elementFields = (el: Element) => ({
    label: nameOf(el),
    textSnippet: clean(el.textContent ?? '', 140),
    html: clean(el.outerHTML, 300),
  });
  const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  const nameOf = (el: Element) => {
    const text = (e: Element | null) => (e as HTMLElement | null)?.innerText ?? e?.textContent;
    const ownText = el.matches(`${HEADING}, button, a[href], label, summary, legend`);
    return spotName([
      el.getAttribute('aria-label'),
      ownText ? text(el) : null,
      text(el.querySelector(HEADING)),
      labelOf(el),
    ]);
  };

  // ---- shadow host ----------------------------------------------------------
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  (document.body || document.documentElement).appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  // Keep widget interaction off the host page's own handlers — typing 'w' in a
  // comment must not scroll a game, arrows must not move tiles, wheel over the
  // panel must not feed a scroll-jack library (html-grab lesson). Bubble-phase
  // on the shadow root: every widget handler runs earlier (document-capture
  // onKey on the way down, per-element listeners at target), so only the leak
  // out to the page is cut. Capture-phase page listeners on document still see
  // the event first — that's not stoppable from in here.
  for (const type of ['keydown', 'keypress', 'keyup', 'wheel', 'mousedown'] as const) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }
  root.innerHTML = `<style>${WIDGET_CSS}</style>
    <div class="layer">
      <div class="hi" id="hi"><span class="hl" id="hl"></span></div>
      <div id="pins"></div>
      <div class="pop" id="pop" role="dialog" aria-label="Comment"></div>
      <aside class="panel" id="panel" aria-label="Comments"></aside>
      <div class="fab" id="fab" role="toolbar" aria-label="Comments">
        <button class="ib" data-act="pick" aria-label="New comment" data-tip="New comment">${icon('comment')}</button>
        <button class="ib" data-act="panel" aria-label="Comments panel" data-tip="Comments">${icon('panel')}<span class="badge" id="badge" hidden></span></button>
        <span class="sep" aria-hidden="true"></span>
        <button class="ib" data-act="min" aria-label="Minimize" data-tip="Minimize">${icon('minimize')}</button>
      </div>
      <button class="nub" id="nub" data-act="restore" aria-label="Show comments" data-tip="Comments"></button>
      <div class="qbar" id="qbar" role="toolbar" aria-label="Comment or react"></div>
      <div class="menu" id="menu" role="menu"></div>
      <div class="toast" id="toast" role="status"></div>
    </div>`;
  const $ = (id: string) => root.getElementById(id)!;
  const hi = $('hi'),
    hiLabel = $('hl'),
    pins = $('pins'),
    pop = $('pop'),
    panelEl = $('panel'),
    fab = $('fab'),
    badge = $('badge'),
    nub = $('nub'),
    menu = $('menu'),
    qbar = $('qbar'),
    toastEl = $('toast');
  const layer = root.querySelector('.layer')!;

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toast = (m: string) => {
    toastEl.textContent = m;
    toastEl.classList.add('show');
    // One timer, reset per toast — an earlier toast's timer must not cut a
    // later message (e.g. the publish-all summary) short.
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  };

  // Page identity includes the query string — ?tab=billing is a different page
  // to comment on. Comments saved before this (or via the CLI) may carry a bare
  // pathname, so those still match anywhere on the path.
  const pageId = () => location.pathname + location.search;
  const here = (page: string) => page === pageId() || page === location.pathname;

  // ---- pick mode ------------------------------------------------------------
  let picking = false;
  const setPick = (on: boolean) => {
    picking = on;
    snapshot = null;
    if (on) closeBar();
    hi.style.display = 'none';
    const b = fab.querySelector<HTMLElement>('[data-act="pick"]')!;
    b.classList.toggle('on', on);
    b.setAttribute('data-tip', on ? 'Cancel (Esc)' : 'New comment');
    if (panel.open) renderPanel();
  };
  const elAt = (x: number, y: number): Element | null => {
    const el = document.elementFromPoint(x, y);
    return !el || el === host || host.contains(el) ? null : el;
  };
  const onMove = (e: MouseEvent) => {
    if (!picking) return;
    const el = elAt(e.clientX, e.clientY);
    if (!el) {
      hi.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(hi.style, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    hiLabel.textContent = labelOf(el);
    hi.classList.toggle('no-room-above', r.top < 22);
  };

  type XY = { x: number; y: number };
  interface Capture {
    el: Element;
    anchor: Anchor;
    range: Range | null;
  }

  const SKIP_TEXT = new Set(['script', 'style', 'noscript', 'template']);
  const textFilter = (n: Node) =>
    n.nodeType === Node.TEXT_NODE || (n as Element).localName === 'br'
      ? NodeFilter.FILTER_ACCEPT
      : SKIP_TEXT.has((n as Element).localName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_SKIP;
  /** Walks text nodes and `<br>` elements. */
  const textWalker = (root: Node) =>
    document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, textFilter);

  /** Says, text node by text node, whether the page breaks the line before it. */
  function lineBreaks() {
    const blocks = new Map<Element | null, Element | null>();
    const blockOf = (t: Text) => {
      const p = t.parentElement;
      if (!blocks.has(p)) {
        let el = p;
        while (
          el &&
          el !== document.body &&
          /^(inline|contents)/.test(getComputedStyle(el).display)
        )
          el = el.parentElement;
        blocks.set(p, el);
      }
      return blocks.get(p)!;
    };
    let prev: Element | null | undefined;
    let br = false;
    return {
      br: () => void (br = true),
      before(t: Text): boolean {
        const block = blockOf(t);
        const out = br || (prev !== undefined && block !== prev);
        prev = block;
        br = false;
        return out;
      },
    };
  }

  function scopeText(scope: Element): { nodes: Text[]; flat: FlatText } | null {
    const nodes: Text[] = [];
    const breaks: boolean[] = [];
    const lines = lineBreaks();
    let n = 0;
    const w = textWalker(scope);
    for (let x = w.nextNode(); x; x = w.nextNode()) {
      if (x.nodeType !== Node.TEXT_NODE) {
        lines.br();
        continue;
      }
      const t = x as Text;
      n += t.data.length;
      if (n > SCAN_MAX) return null;
      breaks.push(lines.before(t));
      nodes.push(t);
    }
    return {
      nodes,
      flat: flatten(
        nodes.map((t) => t.data),
        breaks,
      ),
    };
  }

  const liveRange = (): Range | null => {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    return host.contains(r.startContainer) || host.contains(r.endContainer) ? null : r;
  };

  const blockAncestor = (node: Node): Element | null => {
    let el = node instanceof Element ? node : node.parentElement;
    while (el && el !== document.body && /^(inline|contents)$/.test(getComputedStyle(el).display))
      el = el.parentElement;
    return el;
  };

  function flatAt(nodes: Text[], flat: FlatText, container: Node, offset: number): number {
    const k = nodes.indexOf(container as Text);
    if (k >= 0) return flat.toFlat(k, offset);
    const probe = document.createRange();
    probe.setStart(container, offset);
    const next = nodes.findIndex((t) => probe.comparePoint(t, 0) >= 0);
    return next >= 0 ? flat.toFlat(next, 0) : flat.text.length;
  }

  const fractionIn = (el: Element, x: number, y: number) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const f = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;
    return { x: f((x - r.left) / r.width), y: f((y - r.top) / r.height) };
  };

  function quoteAt(range: Range, x: number, y: number): Capture | null {
    const scope = blockAncestor(range.commonAncestorContainer);
    const selector = scope === document.body ? 'body' : scope ? cssPath(scope) : '';
    const scanned = scope && selector ? scopeText(scope) : null;
    if (!scope || !scanned) return null;
    const { nodes, flat } = scanned;
    const quote = captureQuote(
      flat.text,
      flatAt(nodes, flat, range.startContainer, range.startOffset),
      flatAt(nodes, flat, range.endContainer, range.endOffset),
    );
    if (!quote) return null;
    return {
      el: scope,
      anchor: { kind: 'text', selector, quote, point: fractionIn(scope, x, y) },
      range: range.cloneRange(),
    };
  }
  const elementAt = (el: Element, x: number, y: number): Capture => {
    const selector = cssPath(el);
    const anchor: Anchor = selector
      ? { kind: 'element', selector, point: fractionIn(el, x, y) }
      : { kind: 'page' };
    return { el, anchor, range: null };
  };

  function caretAfter(range: Range): XY | null {
    const end = range.cloneRange();
    end.collapse(false);
    const caret = end.getClientRects()[0];
    const r = caret?.height ? caret : [...range.getClientRects()].filter((b) => b.height).pop();
    return r ? { x: r.right, y: r.top } : null;
  }

  // Gesture contract: a click collapses the selection before `click` fires, so
  // mousedown keeps a copy; a drag-select opens compose on mouseup and its
  // trailing click is swallowed. Each gesture opens at most one compose.
  let snapshot: Range | null = null;
  let swallowClick = false;
  const startCompose = (hit: Capture, x: number, y: number) => {
    if (!openCompose(hit, x, y, 'keep-picking')) return false;
    setPick(false);
    return true;
  };
  const onDown = (e: MouseEvent) => {
    pressing = true;
    swallowClick = false;
    snapshot =
      picking && !e.composedPath().includes(host) ? (liveRange()?.cloneRange() ?? null) : null;
  };
  const onUp = (e: MouseEvent) => {
    pressing = false;
    checkSelection();
    if (!picking) return;
    const el = elAt(e.clientX, e.clientY);
    const range = liveRange();
    const hit = el && range?.intersectsNode(el) ? quoteAt(range, e.clientX, e.clientY) : null;
    if (hit && startCompose(hit, e.clientX, e.clientY)) swallowClick = true;
  };
  const onClick = (e: MouseEvent) => {
    if (swallowClick) {
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!picking) return;
    const el = elAt(e.clientX, e.clientY);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const range = liveRange() ?? snapshot;
    snapshot = null;
    const hit =
      (range?.intersectsNode(el) && quoteAt(range, e.clientX, e.clientY)) ||
      elementAt(el, e.clientX, e.clientY);
    startCompose(hit, e.clientX, e.clientY);
  };
  const pickOrQuote = () => {
    const range = picking ? null : liveRange();
    const end = range && caretAfter(range);
    const hit = range && end && quoteAt(range, end.x, end.y);
    if (hit && end) startCompose(hit, end.x, end.y);
    else setPick(!picking);
  };

  type Bar =
    | { kind: 'closed' }
    | { kind: 'selection'; range: Range; step: 'actions' | 'emoji' }
    | { kind: 'target'; thread: string; to: string; from: DOMRect };
  let bar: Bar = { kind: 'closed' };
  const coarse = matchMedia('(pointer: coarse)');
  const lastLine = (r: Range) =>
    [...r.getClientRects()].filter((b) => b.width || b.height).pop() ?? null;

  function closeBar() {
    if (bar.kind === 'closed') return;
    bar = { kind: 'closed' };
    qbar.classList.remove('in', 'show');
  }
  function placeBar() {
    if (bar.kind === 'closed') return;
    const box = bar.kind === 'target' ? bar.from : lastLine(bar.range);
    if (!box || box.bottom < 0 || box.top > innerHeight) return closeBar();
    const w = qbar.offsetWidth;
    const h = qbar.offsetHeight;
    const right = innerWidth - (bar.kind === 'selection' && docked ? PANEL_W : 0);
    // On touch the OS selection callout sits above the selection.
    const below = bar.kind === 'target' || coarse.matches || box.top - h - 8 < 8;
    const x = bar.kind === 'target' ? box.left - 4 : box.right - w / 2;
    const top = below
      ? Math.min(box.bottom + (coarse.matches ? 12 : 6), innerHeight - h - 8)
      : box.top - h - 8;
    qbar.style.left = `${Math.min(Math.max(8, x), right - w - 8)}px`;
    qbar.style.top = `${top}px`;
    qbar.style.setProperty('--qo', below ? 'center top' : 'center bottom');
  }
  function showBar(next: Exclude<Bar, { kind: 'closed' }>) {
    const fresh = bar.kind === 'closed';
    bar = next;
    qbar.innerHTML = quickBarHtml(next.kind === 'selection' ? next.step : 'emoji');
    qbar.classList.add('show');
    placeBar();
    if (fresh) requestAnimationFrame(() => bar.kind !== 'closed' && qbar.classList.add('in'));
  }

  const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
  function barSelection(): Range | null {
    if (hidden || collapsed || picking) return null;
    const range = liveRange();
    if (!range || !range.toString().trim()) return null;
    const active = document.activeElement as HTMLElement | null;
    if (active?.matches(EDITABLE) || active?.isContentEditable) return null;
    const node = range.commonAncestorContainer;
    const el = (node instanceof Element ? node : node.parentElement) as HTMLElement | null;
    return !el || el.closest(EDITABLE) || el.isContentEditable ? null : range;
  }
  const sameRange = (a: Range, b: Range) =>
    a.compareBoundaryPoints(Range.START_TO_START, b) === 0 &&
    a.compareBoundaryPoints(Range.END_TO_END, b) === 0;
  let pressing = false;
  let selTimer: ReturnType<typeof setTimeout> | undefined;
  function checkSelection() {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (pressing || bar.kind === 'target') return;
      const range = barSelection();
      if (!range) return bar.kind === 'selection' ? closeBar() : undefined;
      if (bar.kind === 'selection' && sameRange(bar.range, range)) return;
      showBar({ kind: 'selection', range: range.cloneRange(), step: 'actions' });
    }, 200);
  }

  async function reactOnPage(range: Range, emoji: Emoji) {
    const end = caretAfter(range);
    const hit = end && quoteAt(range, end.x, end.y);
    if (!hit) return toast('Could not quote that selection');
    document.getSelection()?.removeAllRanges();
    try {
      await action('create', {
        text: '',
        reaction: emoji,
        page: pageId(),
        ...anchorFields(hit.anchor),
        ...elementFields(hit.el),
      });
    } catch {
      toast('Could not add the reaction');
    }
  }

  const reacting = new Set<string>();
  async function setReaction(threadId: string, to: string, emoji: Emoji, how: 'add' | 'toggle') {
    const t = threadById(threadId);
    const target = t?.id === to ? t : t?.replies.find((r) => r.id === to);
    if (!t || t.kind === 'draft' || !target) return;
    const mine = target.reactions.find((r) => r.emoji === emoji)?.mine ?? null;
    const k = `${to}:${emoji}`;
    if ((mine && how === 'add') || reacting.has(k)) return;
    reacting.add(k);
    try {
      if (mine) await action('delete', { id: mine });
      else await action('react', { id: to, emoji });
    } catch {
      toast(mine ? 'Could not remove the reaction' : 'Could not add the reaction');
    } finally {
      reacting.delete(k);
    }
  }

  function placePop(x: number, y: number) {
    const w = 360;
    const right = innerWidth - (docked ? PANEL_W : 0);
    const px = Math.min(Math.max(8, x), right - w - 8);
    const h = pop.offsetHeight || 220;
    const py = Math.max(8, Math.min(y + 12, innerHeight - h - 8));
    pop.style.left = `${px}px`;
    pop.style.top = `${py}px`;
    pop.style.setProperty('--po', `${x - px}px ${y - py}px`);
  }
  function autogrow(ta: HTMLTextAreaElement) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }
  let popCloseTimer: ReturnType<typeof setTimeout> | undefined;
  function openPop() {
    // A pending close (click-away, then an immediate reopen — e.g. pick-click:
    // mousedown closes, click opens) must not hide the popover it didn't own.
    clearTimeout(popCloseTimer);
    pop.classList.add('show');
    requestAnimationFrame(() => pop.classList.add('in'));
  }
  function closePop() {
    const wasShowing = pop.classList.contains('show');
    pop.classList.remove('in');
    popCloseTimer = setTimeout(() => pop.classList.remove('show'), 160);
    const hadState = !!popThread || !!pendingRange;
    popThread = null;
    pendingRange = null;
    if (armed && !panel.open) armed = null;
    if (wasShowing && hadState) render();
  }
  const popHasUnsavedText = () =>
    pop.classList.contains('in') &&
    [...pop.querySelectorAll('textarea')].some(
      (ta) => ta.value.trim() !== '' && ta.value !== ta.defaultValue,
    );
  let shakeTimer: ReturnType<typeof setTimeout> | undefined;
  const nudge = () => {
    pop.classList.remove('shake');
    void pop.offsetWidth;
    pop.classList.add('shake');
    clearTimeout(shakeTimer);
    shakeTimer = setTimeout(() => pop.classList.remove('shake'), 400);
    pop.querySelector('textarea')?.focus();
  };
  function showPop(html: string, x: number, y: number): boolean {
    if (popHasUnsavedText()) {
      nudge();
      return false;
    }
    popThread = null;
    pop.innerHTML = html;
    pop.classList.add('show');
    placePop(x, y);
    openPop();
    return true;
  }

  function openCompose(
    { el, anchor, range }: Capture,
    x: number,
    y: number,
    after: 'keep-picking' | 'done',
  ): boolean {
    const q = anchor.kind === 'text' ? anchor.quote : null;
    const opened = showPop(
      `<div class="compose"><p class="ctx">New comment · ${q ? 'on the selected words' : escapeHtml(nameOf(el))}</p>${q ? quoteHtml(q, false, 200) : ''}
      <div class="field"><textarea placeholder="Add a comment…" aria-label="Comment"></textarea></div>
      <div class="bar"><span class="note">Saved in your browser</span><button class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm pri" data-save>Save draft</button></div></div>`,
      x,
      y,
    );
    if (!opened) return false;
    if (range) {
      document.getSelection()?.removeAllRanges();
      pendingRange = range;
      paint();
    }
    const ta = pop.querySelector('textarea')!;
    ta.focus();
    pop.querySelector<HTMLElement>('[data-cancel]')!.onclick = closePop;
    pop.querySelector<HTMLElement>('[data-save]')!.onclick = () => {
      const text = ta.value.trim();
      if (!text) {
        ta.focus();
        return;
      }
      drafts.push({
        id: `d-${Date.now().toString(36)}-${Math.floor(performance.now())}`,
        text,
        page: pageId(),
        ...anchorFields(anchor),
        ...elementFields(el),
        dataAttrs: clean(
          [...el.attributes]
            .filter((a) => a.name.startsWith('data-'))
            .map((a) => `${a.name}="${a.value}"`)
            .join(' '),
          200,
        ),
        createdAt: new Date().toISOString(),
      });
      saveDrafts();
      closePop();
      render();
      if (after === 'done') {
        toast('Draft saved');
        return;
      }
      toast('Draft saved. Click the next spot, or Esc to stop.');
      setPick(true);
    };
    ta.onkeydown = (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))
        pop.querySelector<HTMLElement>('[data-save]')!.click();
      if (ev.key === 'Escape') closePop();
    };
    return true;
  }

  const threadOpts = (t: Thread, surface: 'panel' | 'pop') => ({
    open: surface === 'pop' || panel.expanded?.id === t.id,
    armed: armed === t.id,
    since: surface === 'pop' ? popThread?.since : panel.expanded?.since,
    lost: anchorLost(t.id),
    me: me.email,
    surface,
    elsewhere: here(t.page) ? '' : t.page,
  });

  function openThreadPop(t: Thread, at: DOMRect) {
    if (!showPop(threadHtml(t, threadOpts(t, 'pop')), at.right + 4, at.top - 8)) return;
    popThread = { id: t.id, since: t.seenAt };
    armed = null;
    if (t.unread) markRead(t.id);
    render();
  }

  function redraw(container: HTMLElement, html: string) {
    const list = container.querySelector('.list');
    const scroll = list?.scrollTop ?? 0;
    const active = root.activeElement as HTMLTextAreaElement | null;
    const focusKey = active && container.contains(active) ? active.dataset.keep : undefined;
    const sel = focusKey ? [active!.selectionStart, active!.selectionEnd] : null;
    container.innerHTML = html;
    const newList = container.querySelector('.list');
    if (newList) newList.scrollTop = scroll;
    for (const ta of container.querySelectorAll<HTMLTextAreaElement>('textarea[data-keep]')) {
      const draft = drafts.find((d) => d.id === ta.dataset.draft);
      if (draft) ta.defaultValue = draft.text;
      ta.value = buffers.get(ta.dataset.keep!) ?? draft?.text ?? '';
      const send = ta.parentElement?.querySelector<HTMLButtonElement>('.send');
      if (send) send.disabled = !ta.value.trim();
      autogrow(ta);
      if (ta.dataset.keep === focusKey) {
        ta.focus();
        if (sel) ta.setSelectionRange(sel[0], sel[1]);
      }
    }
  }

  async function sendReply(id: string) {
    const k = `reply:${id}`;
    const text = (buffers.get(k) ?? '').trim();
    if (!text) return;
    try {
      await action('reply', { id, text });
      buffers.delete(k);
      render();
    } catch {
      toast('Reply failed. Your text is still here.');
    }
  }

  async function setStatus(id: string, to: 'resolve' | 'reopen') {
    try {
      await action(to, { id });
      if (to === 'resolve' && panel.expanded?.id === id) panel.expanded = null;
      toast(to === 'resolve' ? 'Resolved' : 'Reopened');
      render();
    } catch {
      toast(to === 'resolve' ? 'Could not resolve it' : 'Could not reopen it');
    }
  }

  async function deleteThread(id: string) {
    armed = null;
    try {
      await action('delete', { id });
      if (panel.expanded?.id === id) panel.expanded = null;
      if (popThread?.id === id) closePop();
      toast('Deleted');
      render();
    } catch {
      toast('Could not delete it');
      render();
    }
  }

  function discardDraft(id: string) {
    drafts = drafts.filter((d) => d.id !== id);
    saveDrafts();
    buffers.delete(`draft:${id}`);
    armed = null;
    if (panel.expanded?.id === id) panel.expanded = null;
    if (popThread?.id === id) closePop();
    render();
    toast('Draft discarded');
  }

  function saveDraftEdit(id: string): boolean {
    const d = drafts.find((x) => x.id === id);
    const text = buffers.get(`draft:${id}`)?.trim();
    if (!d || text === undefined) return !!d;
    if (!text) return false;
    d.text = text;
    saveDrafts();
    buffers.delete(`draft:${id}`);
    return true;
  }

  async function publishDraft(id: string): Promise<boolean> {
    if (!saveDraftEdit(id)) return false;
    const d = drafts.find((x) => x.id === id);
    if (!d) return true; // already gone — nothing left to publish
    try {
      const doc = await action('create', {
        text: d.text,
        page: d.page,
        ...anchorFields(anchorOfRecord(d)),
        label: d.label,
        textSnippet: d.textSnippet,
        html: d.html,
      });
      drafts = drafts.filter((x) => x.id !== id);
      saveDrafts();
      if (panel.expanded?.id === id)
        panel.expanded = { id: doc.id, since: undefined, wasUnread: false };
      if (popThread?.id === id) closePop();
      render();
      return true;
    } catch {
      toast('Publish failed. The draft is kept.');
      return false;
    }
  }

  async function publishAll(): Promise<void> {
    let ok = 0,
      failed = 0;
    for (const d of [...drafts]) (await publishDraft(d.id)) ? ok++ : failed++;
    toast(
      failed
        ? `Published ${ok} of ${ok + failed}. The failed drafts are kept.`
        : `Published ${ok} draft${ok === 1 ? '' : 's'}`,
    );
  }

  // ---- markdown export ------------------------------------------------------
  function draftsMarkdown(): string {
    let out = `# comment drafts on ${SITE}\n`;
    for (const d of drafts) {
      out += `\n## ${d.text}\n- page: \`${d.page}\`\n`;
      for (const line of anchorLines(anchorOfRecord(d))) out += `${line}\n`;
      if (d.textSnippet) out += `- text: "${d.textSnippet}"\n`;
      if (d.dataAttrs) out += `- data: \`${d.dataAttrs}\`\n`;
    }
    return out;
  }

  /** The whole log, drafts and published, with replies and reactions. The
   *  widget twin of `brisk plugin comments export`. */
  const commentsMarkdown = () =>
    `# comments on ${SITE}\n${threads.map((t) => `\n${threadMarkdown(t)}\n`).join('')}`;

  // Clipboard writes reject on denied permission or an insecure context — fall
  // back to downloading the file so the export is never silently lost.
  function download(name: string, text: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const clip = (name: string, text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast('Copied. Paste it to your agent.'),
      () => {
        download(name, text);
        toast('Clipboard blocked, so it downloaded instead');
      },
    );

  const findTarget = (selector: string): Element | null => {
    try {
      return selector ? document.querySelector(selector) : null;
    } catch {
      return null; // invalid selector
    }
  };
  /** A hidden element keeps its box: a deck stacks every slide at inset:0 and
   *  hides all but one with visibility/opacity, so its comments would otherwise
   *  pin themselves over whatever slide you are reading. */
  const onScreen = (el: Element): boolean => {
    if (
      typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({
        contentVisibilityAuto: true,
        opacityProperty: true,
        visibilityProperty: true,
        checkOpacity: true,
        checkVisibilityCSS: true,
      })
    )
      return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };

  type Placement =
    | { kind: 'page' }
    | { kind: 'detached' }
    | { kind: 'hidden' }
    | { kind: 'text'; range: Range; at: XY }
    | { kind: 'element'; at: XY };
  interface Slot {
    thread: Thread;
    pin: HTMLButtonElement;
    placement: Placement;
  }
  let slots = new Map<string, Slot>();
  const anchorLost = (id: string) => {
    const s = slots.get(id);
    const p = s?.placement.kind;
    return p === 'detached' || (p === 'element' && s!.thread.anchor.kind === 'text');
  };

  interface TextCache {
    scope: Element;
    range: Range | null;
    mutatedSinceResolve: boolean;
    scannedAt: number;
  }
  const textCache = new Map<string, TextCache>();
  const LOST_QUOTE_RESCAN_MS = 1000;
  let rescanTimer: ReturnType<typeof setTimeout> | undefined;

  function rangeStillReadsAs(range: Range, exact: string): boolean {
    if (range.collapsed) return false;
    const max = exact.length * 4 + 64;
    const chunks: string[] = [];
    const breaks: boolean[] = [];
    const lines = lineBreaks();
    let n = 0;
    const w = textWalker(range.commonAncestorContainer);
    w.currentNode = range.startContainer;
    let t: Node | null =
      range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer : w.nextNode();
    for (; t; t = w.nextNode()) {
      if (!range.intersectsNode(t)) {
        if (range.comparePoint(t, 0) > 0) break;
        continue;
      }
      if (t.nodeType !== Node.TEXT_NODE) {
        lines.br();
        continue;
      }
      const data = (t as Text).data;
      const s = t === range.startContainer ? range.startOffset : 0;
      const e = t === range.endContainer ? range.endOffset : data.length;
      n += e - s;
      if (n > max) return false;
      breaks.push(lines.before(t as Text));
      chunks.push(data.slice(s, e));
    }
    return flatten(chunks, breaks).text === exact;
  }

  function quoteRange(id: string, scope: Element, q: Quote): Range | null {
    let c = textCache.get(id);
    if (!c || c.scope !== scope) {
      c = { scope, range: null, mutatedSinceResolve: true, scannedAt: -Infinity };
      textCache.set(id, c);
    }
    // Moving a node pulls a Range's endpoints out to its old parent, and the
    // mutation records name only the parents, so check the endpoints too.
    const held = (r: Range) => scope.contains(r.startContainer) && scope.contains(r.endContainer);
    if (!c.mutatedSinceResolve && (!c.range || held(c.range))) return c.range;
    if (c.range && held(c.range) && rangeStillReadsAs(c.range, q.exact)) {
      c.mutatedSinceResolve = false;
      return c.range;
    }
    const wait = c.scannedAt + LOST_QUOTE_RESCAN_MS - performance.now();
    if (!c.range && wait > 0) {
      rescanTimer ??= setTimeout(() => {
        rescanTimer = undefined;
        scheduleReposition();
      }, wait);
      return null;
    }
    c.mutatedSinceResolve = false;
    c.scannedAt = performance.now();
    c.range = null;
    const scanned = scopeText(scope);
    if (!scanned) return null;
    const { nodes, flat } = scanned;
    const hit = locateQuote(flat.text, q);
    if (!hit) return null;
    const s = flat.toRaw(hit.start, 'start');
    const e = flat.toRaw(hit.end, 'end');
    c.range = document.createRange();
    c.range.setStart(nodes[s.chunk]!, s.offset);
    c.range.setEnd(nodes[e.chunk]!, e.offset);
    return c.range;
  }

  function place(t: Thread): Placement {
    const a = t.anchor;
    if (a.kind === 'page') return { kind: 'page' };
    const el = findTarget(a.selector);
    if (!el) {
      textCache.delete(t.id);
      return { kind: 'detached' };
    }
    if (!onScreen(el)) return { kind: 'hidden' };
    if (a.kind === 'text') {
      const range = quoteRange(t.id, el, a.quote);
      if (range) {
        const end = caretAfter(range);
        return end
          ? { kind: 'text', range, at: { x: end.x - 4, y: end.y + 3 } }
          : { kind: 'hidden' };
      }
    }
    const r = el.getBoundingClientRect();
    const at = a.point
      ? { x: r.left + a.point.x * r.width, y: r.top + a.point.y * r.height }
      : { x: r.right - 11, y: r.top + 11 };
    return { kind: 'element', at };
  }
  const applyPin = (pin: HTMLElement, p: Placement) => {
    pin.classList.toggle('detached', p.kind === 'detached');
    pin.style.display = p.kind === 'hidden' ? 'none' : '';
    const at = p.kind === 'text' || p.kind === 'element' ? p.at : { x: 12, y: 34 };
    pin.style.left = `${at.x}px`;
    pin.style.top = `${at.y}px`;
  };

  const focusedId = () => popThread?.id ?? (panel.open ? panel.expanded?.id : undefined) ?? '';

  function renderPins() {
    const next = new Map<string, Slot>();
    for (const t of threads) {
      if (!here(t.page) || !pinShown(t, panel.filter)) continue;
      let s = slots.get(t.id);
      if (!s) {
        const pin = document.createElement('button');
        pin.dataset.act = 'pin';
        pin.dataset.id = t.id;
        pins.appendChild(pin);
        s = { thread: t, pin, placement: { kind: 'hidden' } };
      }
      s.thread = t;
      const { pin } = s;
      pin.className = [
        'pin',
        t.reaction ? 'reaction' : '',
        t.kind === 'draft' ? 'draft' : t.status !== 'open' ? t.status : t.unread ? '' : 'read',
        t.id === focusedId() ? 'on' : '',
        pin.classList.contains('flash') ? 'flash' : '',
      ]
        .filter(Boolean)
        .join(' ');
      pin.textContent = t.reaction ?? String(t.num);
      pin.title = `#${t.num} · ${t.author}${t.reaction ? ` reacted ${t.reaction}` : ` · ${clean(t.text, 60)}`}`;
      const kind = t.reaction ? `reaction ${t.reaction}` : 'comment';
      pin.setAttribute(
        'aria-label',
        `${t.unread ? `Unread ${kind}` : kind[0]!.toUpperCase() + kind.slice(1)} ${t.num} by ${t.author}`,
      );
      s.placement = place(t);
      applyPin(pin, s.placement);
      next.set(t.id, s);
    }
    for (const [id, s] of slots) if (!next.has(id)) s.pin.remove();
    slots = next;
    for (const id of textCache.keys()) if (!slots.has(id)) textCache.delete(id);
    pins.style.display = pinsHidden ? 'none' : '';
  }

  const flash = (id: string) => {
    const pin = slots.get(id)?.pin;
    if (!pin || reducedMotion.matches) return;
    pin.classList.remove('flash');
    void pin.offsetWidth;
    pin.classList.add('flash');
    setTimeout(() => pin.classList.remove('flash'), 1900);
  };

  function revealOnPage(t: Thread) {
    const s = slots.get(t.id);
    const target = t.anchor.kind === 'page' ? null : findTarget(t.anchor.selector);
    const box =
      s?.placement.kind === 'text'
        ? s.placement.range.getBoundingClientRect()
        : target?.getBoundingClientRect();
    const off = box && (box.bottom < 0 || box.top > innerHeight);
    if (off && target)
      target.scrollIntoView({
        block: 'center',
        behavior: reducedMotion.matches ? 'auto' : 'smooth',
      });
    setTimeout(() => flash(t.id), off ? 450 : 0);
  }

  let marks: { all: Highlight; focus: Highlight; sheet: CSSStyleSheet } | null = null;
  try {
    if (CSS.highlights && typeof Highlight === 'function') {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(HIGHLIGHT_CSS);
      marks = { all: new Highlight(), focus: new Highlight(), sheet };
    }
  } catch (err) {
    console.warn('[comments] highlights unavailable:', err);
  }
  let pendingRange: Range | null = null;

  function paint() {
    if (!marks) return;
    try {
      const { all, focus, sheet } = marks;
      // A page may replace these wholesale; put ours back.
      if (!document.adoptedStyleSheets.includes(sheet))
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      if (CSS.highlights.get('brisk-comment') !== all) CSS.highlights.set('brisk-comment', all);
      if (CSS.highlights.get('brisk-comment-focus') !== focus)
        CSS.highlights.set('brisk-comment-focus', focus);
      all.clear();
      focus.clear();
      if (hidden || collapsed) return;
      if (pendingRange) focus.add(pendingRange);
      if (pinsHidden) return;
      const focused = focusedId();
      for (const s of slots.values()) {
        if (s.placement.kind !== 'text' || s.thread.status !== 'open') continue;
        (s.thread.id === focused ? focus : all).add(s.placement.range);
      }
    } catch (err) {
      marks = null;
      console.warn('[comments] highlights disabled:', err);
    }
  }

  // ---- render -----------------------------------------------------------------
  function render() {
    const seen = { ...serverSeen, ...Object.fromEntries(pendingSeen) };
    threads = buildThreads({ drafts, docs: published, seen, me: me.email });
    if (!seenReady) for (const t of threads) t.unread = false;
    if (panel.expanded && !threadById(panel.expanded.id)) panel.expanded = null;
    renderPins();
    paint();
    if (panel.open) renderPanel();
    if (popThread) {
      const t = threadById(popThread.id);
      if (t) redraw(pop, threadHtml(t, threadOpts(t, 'pop')));
      else closePop();
    }
    updateBadges();
    for (const id of [popThread?.id, panel.open ? panel.expanded?.id : undefined]) {
      const t = threadById(id);
      if (t?.unread && !pendingSeen.has(t.id)) markRead(t.id);
    }
  }

  /** Scroll/resize path: move the existing pins, coalesced to one rAF. */
  let repositionQueued = false;
  const scheduleReposition = () => {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      for (const s of slots.values()) {
        s.placement = place(s.thread);
        applyPin(s.pin, s.placement);
      }
      if (bar.kind === 'selection') placeBar();
      paint();
    });
  };

  function renderPanel() {
    const view = panelView(threads, panel, here);
    redraw(
      panelEl,
      panelHtml(view, panel, {
        site: SITE,
        picking,
        drafts: drafts.length,
        thread: (t) => threadOpts(t, 'panel'),
      }),
    );
  }
  const rowOf = (id: string) =>
    panelEl.querySelector<HTMLElement>(`.th[data-id="${CSS.escape(id)}"]`);

  function setPanelOpen(open: boolean) {
    if (open && popThread) {
      const t = threadById(popThread.id);
      if (t) panel.expanded = { id: t.id, since: popThread.since, wasUnread: false };
      closePop();
    }
    panel.open = open;
    remember('panel', open ? '1' : '0');
    if (!open) {
      panel.expanded = null;
      armed = null;
    }
    panelEl.classList.toggle('open', open);
    layer.classList.toggle('panel-open', open);
    applyDock();
    render();
    if (open)
      panelEl.querySelector<HTMLElement>('[data-act="close"]')?.focus({ preventScroll: true });
  }

  function setFilter(f: Filter) {
    panel.filter = f;
    remember('filter', f);
    armed = null;
    render();
  }

  function expand(id: string) {
    const t = threadById(id);
    if (!t) return;
    if (t.kind === 'published' && !matches(t, panel.filter, null)) setFilter(t.status);
    if (panel.scope === 'page' && !here(t.page)) {
      panel.scope = 'site';
      remember('scope', 'site');
    }
    panel.expanded = { id, since: t.seenAt, wasUnread: t.unread };
    armed = null;
    if (t.unread) markRead(id);
    render();
    rowOf(id)?.scrollIntoView({ block: 'nearest' });
  }
  const collapse = () => {
    panel.expanded = null;
    armed = null;
    render();
  };

  const wide = matchMedia(`(min-width: ${DOCK_MIN}px)`);
  let docked: { value: string; priority: string; hadStyle: boolean } | null = null;
  function applyDock() {
    const want = panel.open && wide.matches && !hidden && !collapsed;
    const html = document.documentElement;
    if (want && !docked) {
      docked = {
        value: html.style.getPropertyValue('margin-right'),
        priority: html.style.getPropertyPriority('margin-right'),
        hadStyle: html.hasAttribute('style'),
      };
      html.style.setProperty('margin-right', `${PANEL_W}px`, 'important');
    } else if (!want && docked) {
      if (docked.value) html.style.setProperty('margin-right', docked.value, docked.priority);
      else html.style.removeProperty('margin-right');
      if (!docked.hadStyle && !html.style.length) html.removeAttribute('style');
      docked = null;
    }
    layer.classList.toggle('docked', !!docked);
    scheduleReposition();
  }
  wide.addEventListener('change', applyDock);

  let menuOpen: { items: () => MenuItem[]; head?: () => string } | null = null;
  let menuArmed = '';
  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = null;
    menuArmed = '';
    menu.classList.remove('in');
    setTimeout(() => !menuOpen && menu.classList.remove('show'), 140);
  }
  function drawMenu() {
    if (menuOpen) menu.innerHTML = menuHtml(menuOpen.items(), menuOpen.head?.());
  }
  function openMenu(items: () => MenuItem[], from: HTMLElement, head?: () => string) {
    menuOpen = { items, head };
    menuArmed = '';
    drawMenu();
    const r = from.getBoundingClientRect();
    const above = r.top > innerHeight / 2;
    Object.assign(menu.style, {
      right: `${Math.max(8, innerWidth - r.right)}px`,
      top: above ? 'auto' : `${r.bottom + 4}px`,
      bottom: above ? `${innerHeight - r.top + 8}px` : 'auto',
    });
    menu.style.setProperty('--mo', above ? 'bottom right' : 'top right');
    menu.classList.add('show');
    requestAnimationFrame(() => menu.classList.add('in'));
  }
  const toggleMenu = (items: () => MenuItem[], from: HTMLElement, head?: () => string) =>
    menuOpen ? closeMenu() : openMenu(items, from, head);

  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const commandItems = (fromPanel: boolean) => (): MenuItem[] => {
    const n = drafts.length;
    return [
      ...(fromPanel
        ? []
        : ([
            { act: 'pick', label: 'New comment', icon: 'comment' },
            { act: 'panel', label: panel.open ? 'Close comments' : 'Open comments', icon: 'panel' },
            'sep',
          ] as MenuItem[])),
      { act: 'copy-all', label: 'Copy all as Markdown', icon: 'copy' },
      ...(n
        ? ([
            { act: 'copy-drafts', label: `Copy ${plural(n, 'draft')}`, icon: 'copy' },
            { act: 'publish-all', label: `Publish ${plural(n, 'draft')}`, icon: 'publish' },
            {
              act: 'discard-drafts',
              label:
                menuArmed === 'discard-drafts'
                  ? `Click again to discard ${plural(n, 'draft')}`
                  : `Discard ${plural(n, 'draft')}`,
              icon: 'trash',
              armed: menuArmed === 'discard-drafts',
            },
          ] as MenuItem[])
        : []),
      'sep',
      pinsHidden
        ? { act: 'toggle-pins', label: 'Show pins', icon: 'eye' }
        : { act: 'toggle-pins', label: 'Hide pins', icon: 'eyeOff' },
      ...(fromPanel ? [] : ([{ act: 'min', label: 'Minimize', icon: 'minimize' }] as MenuItem[])),
      { act: 'hide', label: 'Hide until Shift+C', icon: 'hide' },
    ];
  };
  const commandHead = () => {
    const open = threads.filter((t) => t.status === 'open').length;
    const unread = threads.filter((t) => t.unread).length;
    return `${SITE} · ${open} open · ${unread} unread · ${plural(drafts.length, 'draft')}`;
  };
  const statusItems = (): MenuItem[] => {
    const counts = panelView(threads, panel, here).filterCounts;
    return (['resolved', 'deleted'] as const).map((f) => ({
      act: 'filter',
      v: f,
      label: f === 'resolved' ? 'Resolved' : 'Deleted',
      icon: f === 'resolved' ? 'check' : 'trash',
      k: String(counts[f]),
      on: panel.filter === f,
    }));
  };

  // ---- minimize / hide / restore --------------------------------------------
  // Minimize collapses to a small bubble that's always visible — click it to
  // reopen. Shift+C fully hides everything (bubble included) for clean shots.
  function updateBadges() {
    const unread = threads.filter((t) => t.unread && here(t.page)).length;
    badge.hidden = unread === 0;
    badge.textContent = String(unread);
    nub.classList.toggle('has', unread > 0);
    nub.innerHTML = unread > 0 ? String(unread) : icon('comment');
    nub.setAttribute('data-tip', unread > 0 ? `${plural(unread, 'unread comment')}` : 'Comments');
  }
  function setCollapsed(on: boolean) {
    collapsed = on;
    remember('collapsed', on ? '1' : '0');
    applyCollapsed();
  }
  function applyCollapsed() {
    layer.classList.toggle('collapsed', collapsed);
    closeBar();
    if (collapsed) {
      closePop();
      if (panel.open) setPanelOpen(false);
    }
    applyDock();
    paint();
  }
  function applyHidden() {
    host.style.display = hidden ? 'none' : '';
    closeBar();
    applyDock();
    paint();
  }
  const togglePins = () => {
    pinsHidden = !pinsHidden;
    remember('pins', pinsHidden ? '1' : '0');
    render();
  };

  const idOf = (el: HTMLElement) => el.closest<HTMLElement>('[data-id]')?.dataset.id ?? '';
  const commands: Record<string, (el: HTMLElement) => void> = {
    pin: (el) => {
      const t = threadById(idOf(el));
      if (!t) return;
      if (panel.open) expand(t.id);
      else openThreadPop(t, el.getBoundingClientRect());
    },
    expand: (el) => {
      const t = threadById(idOf(el));
      if (!t) return;
      if (t.page && !here(t.page)) {
        remember('goto', t.id);
        location.assign(t.page);
        return;
      }
      expand(t.id);
      revealOnPage(t);
    },
    collapse,
    scope: (el) => {
      panel.scope = parseScope(el.dataset.v ?? null);
      remember('scope', panel.scope);
      panel.expanded = null;
      render();
    },
    filter: (el) => setFilter(parseFilter(el.dataset.v ?? null)),
    'status-menu': (el) => toggleMenu(statusItems, el),
    'more-menu': (el) => toggleMenu(commandItems(true), el, commandHead),
    'goto-page': (el) => location.assign(el.dataset.v ?? '/'),
    close: () => setPanelOpen(false),
    panel: () => setPanelOpen(!panel.open),
    pick: pickOrQuote,
    min: () => setCollapsed(true),
    restore: () => setCollapsed(false),
    resolve: (el) => void setStatus(idOf(el), 'resolve'),
    reopen: (el) => void setStatus(idOf(el), 'reopen'),
    read: (el) => markRead(idOf(el)),
    unread: (el) => markUnread(idOf(el)),
    delete: (el) => {
      armed = idOf(el);
      render();
      (popThread ? pop : panelEl)
        .querySelector<HTMLElement>('[data-act="confirm-delete"]')
        ?.focus();
    },
    disarm: () => {
      armed = null;
      render();
    },
    'confirm-delete': (el) => {
      const t = threadById(idOf(el));
      if (t?.kind === 'draft') discardDraft(t.id);
      else if (t) void deleteThread(t.id);
    },
    reply: (el) => void sendReply(idOf(el)),
    publish: (el) => {
      const id = idOf(el);
      void publishDraft(id).then((ok) => ok && toast('Published'));
    },
    'save-draft': (el) => {
      if (saveDraftEdit(idOf(el))) {
        toast('Draft saved');
        render();
      }
    },
    'copy-all': () => void clip(`comments-${SITE}.md`, commentsMarkdown()),
    'copy-drafts': () => void clip(`comment-drafts-${SITE}.md`, draftsMarkdown()),
    'publish-all': () => void publishAll(),
    'discard-drafts': () => {
      drafts = [];
      saveDrafts();
      render();
      toast('Drafts discarded');
    },
    'toggle-pins': togglePins,
    'sel-comment': () => {
      if (bar.kind !== 'selection') return;
      const { range } = bar;
      closeBar();
      const end = caretAfter(range);
      const hit = end && quoteAt(range, end.x, end.y);
      if (hit && end) openCompose(hit, end.x, end.y, 'done');
      else toast('Could not quote that selection');
    },
    'sel-react': () => {
      if (bar.kind === 'selection') showBar({ ...bar, step: 'emoji' });
    },
    emoji: (el) => {
      const emoji = parseEmoji(el.dataset.v);
      const from = bar;
      closeBar();
      if (!emoji) return;
      if (from.kind === 'selection') void reactOnPage(from.range, emoji);
      else if (from.kind === 'target') void setReaction(from.thread, from.to, emoji, 'add');
    },
    react: (el) => {
      const emoji = parseEmoji(el.dataset.v);
      if (emoji) void setReaction(idOf(el), el.dataset.to ?? '', emoji, 'toggle');
    },
    'react-menu': (el) => {
      if (bar.kind === 'target' && bar.to === el.dataset.to) return closeBar();
      showBar({
        kind: 'target',
        thread: idOf(el),
        to: el.dataset.to ?? '',
        from: el.getBoundingClientRect(),
      });
    },
    hide: () => {
      hidden = true;
      remember('hidden', '1');
      applyHidden();
    },
  };
  const ARMED_IN_MENU = new Set(['discard-drafts']);

  root.addEventListener('click', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (!el || (el as HTMLButtonElement).disabled) return;
    const act = el.dataset.act!;
    const run = commands[act];
    if (!run) return;
    if (el.closest('.menu')) {
      if (ARMED_IN_MENU.has(act) && menuArmed !== act) {
        menuArmed = act;
        drawMenu();
        return;
      }
      closeMenu();
    } else if (act !== 'status-menu' && act !== 'more-menu') closeMenu();
    run(el);
  });
  // Pressing Comment or the quick bar must not collapse a selection made first.
  root.addEventListener('mousedown', (e) => {
    const target = e.target as Element;
    if (target.closest('[data-act="pick"], .qbar')) e.preventDefault();
    if (menuOpen && !e.composedPath().includes(menu)) closeMenu();
    if (!e.composedPath().includes(qbar) && !target.closest('[data-act="react-menu"]')) closeBar();
  });
  root.addEventListener('input', (e) => {
    const ta = e.target;
    if (!(ta instanceof HTMLTextAreaElement)) return;
    autogrow(ta);
    if (ta.dataset.keep) buffers.set(ta.dataset.keep, ta.value);
    const send = ta.parentElement?.querySelector<HTMLButtonElement>('.send');
    if (send) send.disabled = !ta.value.trim();
  });
  root.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    const t = e.target as HTMLElement;
    if ((e.key === 'Enter' || e.key === ' ') && t.matches('article[data-act]')) {
      e.preventDefault();
      commands.expand!(t);
      return;
    }
    if (!(t instanceof HTMLTextAreaElement) || !t.dataset.keep) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (t.dataset.reply) void sendReply(t.dataset.reply);
      else if (t.dataset.draft) commands['save-draft']!(t);
    }
    if (e.key === 'Escape' && !popThread) t.blur();
  });
  for (const el of [fab, nub]) {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMenu(commandItems(false), el, commandHead);
    });
  }

  // The hotkey survives hiding: it toggles the whole host in and out.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setPick(false);
      closePop();
      closeMenu();
      closeBar();
    }
    // composedPath, not e.target: this listener sits outside our shadow root,
    // so retargeting would report the host <div> for keys typed in the widget's
    // own textareas — and Shift+C mid-comment would hide the widget.
    const t = (e.composedPath()[0] ?? e.target) as HTMLElement | null;
    const typing =
      !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (
      (e.key === 'C' || e.key === 'c') &&
      e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !typing
    ) {
      hidden = !hidden;
      remember('hidden', hidden ? '1' : '0');
      applyHidden();
    }
  };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('mouseup', onUp, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  const onClickAway = () => {
    if (popHasUnsavedText()) nudge();
    else if (pop.classList.contains('show')) closePop();
    closeMenu();
    closeBar();
  };
  document.addEventListener('selectionchange', checkSelection);
  for (const scroller of [panelEl, pop])
    scroller.addEventListener('scroll', () => bar.kind === 'target' && closeBar(), true);
  document.addEventListener('mousedown', onClickAway, false);
  // Reposition pins on scroll; the popover stays put (it's fixed) so a scrolling
  // textarea can't dismiss it.
  addEventListener('scroll', scheduleReposition, true);
  addEventListener('resize', scheduleReposition, true);
  // A cross-fade leaves the incoming element at opacity 0 for the length of its
  // transition, long after the class flip — re-place when the motion lands too.
  addEventListener('transitionend', scheduleReposition, true);
  addEventListener('animationend', scheduleReposition, true);
  // Slides, tabs and accordions swap what's on screen with a class or style
  // flip and fire no event of their own — watch the markup so pins follow.
  new MutationObserver((records) => {
    let move = false;
    for (const r of records) {
      if (r.type !== 'characterData') move = true;
      if (r.type === 'attributes') continue;
      for (const c of textCache.values()) {
        if (!c.mutatedSinceResolve && c.scope.contains(r.target)) {
          c.mutatedSinceResolve = true;
          move = true;
        }
      }
    }
    if (move) scheduleReposition();
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'],
  });
  // History-routed navigation changes the page identity — re-filter the pins.
  addEventListener('popstate', () => render());

  // ---- boot -----------------------------------------------------------------
  const goto = recall('goto');
  if (goto) localStorage.removeItem(key('goto'));
  panelEl.classList.toggle('open', panel.open);
  layer.classList.toggle('panel-open', panel.open);
  applyHidden();
  applyCollapsed();
  render();
  void refreshPublished().then(() => {
    const t = threadById(goto ?? '');
    if (!t) return;
    if (!panel.open) setPanelOpen(true);
    expand(t.id);
    revealOnPage(t);
  });
})();
