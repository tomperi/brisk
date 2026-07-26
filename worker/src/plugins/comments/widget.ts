/* Brisk comments widget. Injected into pages that enable the comments plugin.
 * Drafts live in localStorage (local-first); publishing promotes them to
 * brisk.db via the plugin's server actions, which stamp the author and append
 * an audit event. Reads use the SDK when the page loads /brisk.js and fall
 * back to the same fetch the write path uses when it doesn't — only realtime
 * needs the SDK (without it the list refreshes after each of our own actions).
 *
 * Look: "Notecard" — Brisk's warm paper + hyperlink blue + monospace, ink
 * borders and hard offset shadows (the deploy modal's family), light/dark aware. */
type Brisk = {
  db: {
    collection(name: string): {
      list(opts?: { limit?: number; sort?: string }): Promise<BdDoc[]>;
      subscribe(h: {
        onCreate?: (d: BdDoc) => void;
        onUpdate?: (d: BdDoc) => void;
        onDelete?: (id: string) => void;
      }): () => void;
    };
  };
};
interface BdDoc {
  id: string;
  createdAt: string;
  [k: string]: unknown;
}

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
  const key = (k: string) => `brisk:comments:${SITE}:${k}`;
  type Status = 'open' | 'resolved' | 'deleted' | 'all';

  const escapeHtml = (s: string) =>
    (s || '').replace(
      /[&<>"]/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!,
    );
  const clean = (s: string, n: number) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  function timeAgo(iso: string): string {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (Number.isNaN(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }

  // ---- local draft store ----------------------------------------------------
  interface Draft {
    id: string;
    text: string;
    page: string;
    selector: string;
    label: string;
    textSnippet: string;
    html: string;
    /** The element's data-* attributes — often the fastest grep for an agent. */
    dataAttrs?: string;
    createdAt: string;
  }
  const loadDrafts = (): Draft[] => {
    try {
      return JSON.parse(localStorage.getItem(key('drafts')) || '[]') as Draft[];
    } catch {
      return [];
    }
  };
  let drafts = loadDrafts();
  const saveDrafts = () => localStorage.setItem(key('drafts'), JSON.stringify(drafts));

  let hidden = localStorage.getItem(key('hidden')) === '1';
  let collapsed = localStorage.getItem(key('collapsed')) === '1';
  let filter = (localStorage.getItem(key('filter')) as Status) || 'open';

  // ---- published comments (brisk.db) ---------------------------------------
  let published: BdDoc[] = [];
  const refreshPublished = async () => {
    if (sdk) {
      published = await sdk.db.collection(COLLECTION).list({ limit: 500, sort: '-created' });
    } else {
      // No /brisk.js on this page: read the collection through the same route
      // the SDK wraps, so published comments still show up.
      const res = await fetch(`/api/db/${COLLECTION}?limit=500&sort=-created`, {
        headers: { 'x-brisk-site': SITE },
      });
      if (!res.ok) return;
      published = ((await res.json()) as { docs: BdDoc[] }).docs;
    }
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
  }

  const action = async (name: string, args: Record<string, string>): Promise<BdDoc> => {
    const res = await fetch(`/api/plugins/comments/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { site: SITE, ...args } }),
    });
    if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
    // With realtime unavailable, our own mutations won't push back — re-read.
    if (!sdk) void refreshPublished();
    return ((await res.json()) as { result: BdDoc }).result;
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

  // ---- shadow host ----------------------------------------------------------
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  (document.body || document.documentElement).appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  // Keep widget interaction off the host page's own handlers — typing 'w' in a
  // comment must not scroll a game, arrows must not move tiles, wheel over the
  // drawer must not feed a scroll-jack library (html-grab lesson). Bubble-phase
  // on the shadow root: every widget handler runs earlier (document-capture
  // onKey on the way down, per-element listeners at target), so only the leak
  // out to the page is cut. Capture-phase page listeners on document still see
  // the event first — that's not stoppable from in here.
  for (const type of ['keydown', 'keypress', 'keyup', 'wheel', 'mousedown'] as const) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }
  root.innerHTML = `
    <style>
      :host {
        --paper: oklch(96.5% 0.012 85);
        --paper-raised: oklch(93.5% 0.014 85);
        --paper-sunk: oklch(99% 0.008 85);
        --ink: oklch(24% 0.015 75);
        --ink-dim: oklch(48% 0.014 75);
        --line: oklch(87% 0.013 85);
        --accent: oklch(46% 0.19 262);
        --accent-soft: oklch(46% 0.19 262 / 0.09);
        --live: oklch(58% 0.15 150);
        --warn: oklch(52% 0.17 25);
        --ease: cubic-bezier(0.23, 1, 0.32, 1);
        --shadow-hard: 0.4rem 0.4rem 0 var(--line);
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --paper: oklch(21% 0.012 75);
          --paper-raised: oklch(26% 0.014 75);
          --paper-sunk: oklch(17% 0.012 75);
          --ink: oklch(89% 0.012 85);
          --ink-dim: oklch(62% 0.012 85);
          --line: oklch(32% 0.012 75);
          --accent: oklch(72% 0.13 262);
          --accent-soft: oklch(72% 0.13 262 / 0.14);
          --live: oklch(72% 0.14 150);
          --warn: oklch(64% 0.16 25);
          --shadow-hard: 0.4rem 0.4rem 0 oklch(0% 0 0 / 0.4);
        }
      }
      * { box-sizing: border-box; }
      .layer {
        position: fixed; inset: 0; pointer-events: none;
        font: 13px/1.5 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; color: var(--ink);
      }
      .hi {
        position: fixed; pointer-events: none; border: 1.5px solid var(--accent);
        background: var(--accent-soft); border-radius: 5px; display: none;
        /* glide between elements instead of snapping; linear because it tracks
           the cursor, and short enough to feel attached to it */
        transition: all 50ms linear;
      }

      /* pins — bold ink-bordered circles with a hard offset shadow */
      .pin {
        position: fixed; width: 24px; height: 24px; margin: -12px 0 0 -12px; border-radius: 50%;
        background: var(--accent); color: var(--paper); font-weight: 700; font-size: 0.72rem;
        display: grid; place-items: center; cursor: pointer; pointer-events: auto;
        border: 1.5px solid var(--ink); box-shadow: 0.12rem 0.12rem 0 var(--ink); user-select: none;
        animation: pin-in 220ms var(--ease) both;
      }
      @keyframes pin-in { from { opacity: 0; transform: scale(0.85); } }
      .pin:active { transform: scale(0.94); }
      .pin.resolved { background: var(--paper-raised); color: var(--ink-dim); }
      .pin.deleted { background: var(--paper-raised); color: var(--warn); opacity: 0.6; }
      .pin.detached { background: var(--warn); }
      .pin.draft { background: var(--live); }

      /* popover (compose + thread) */
      .pop {
        position: fixed; pointer-events: auto; width: 288px; background: var(--paper);
        border: 1.5px solid var(--ink); border-radius: 12px; padding: 13px;
        box-shadow: var(--shadow-hard); display: none; opacity: 0; transform: scale(0.96);
        transform-origin: var(--po, top left);
        transition: opacity 140ms ease-out, transform 150ms var(--ease);
      }
      .pop.show { display: block; }
      .pop.in { opacity: 1; transform: scale(1); }
      .pop textarea {
        width: 100%; min-height: 58px; max-height: 180px; height: 58px; resize: vertical;
        overflow-y: auto; font: inherit; font-size: 0.82rem; line-height: 1.5; color: var(--ink);
        background: var(--paper-sunk); border: 1.5px solid var(--line); border-radius: 8px;
        padding: 7px 8px;
      }
      .pop textarea:focus { outline: none; border-color: var(--accent); }
      .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }

      .chead {
        display: flex; align-items: center; gap: 6px; font-size: 0.74rem; color: var(--ink-dim);
        margin-bottom: 6px;
      }
      .chead strong { color: var(--ink); font-weight: 700; }
      .chead .sicon { font-size: 0.8em; }
      .who { cursor: help; text-decoration: underline dotted var(--ink-dim); text-underline-offset: 2px; }
      .txt { font-size: 0.85rem; white-space: pre-wrap; word-break: break-word; }
      .thread { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
      .reply { position: relative; padding-left: 15px; }
      .reply::before { content: '↳'; position: absolute; left: 0; top: 0; color: var(--ink-dim); }
      .reply .txt { font-size: 0.82rem; }
      .composebar { margin-top: 14px; padding-top: 12px; border-top: 1.5px solid var(--line); }
      .ctx { color: var(--ink-dim); font-size: 0.72rem; margin-bottom: 6px; word-break: break-word; }

      /* drawer — slides on transform only */
      .drawer {
        position: fixed; top: 0; right: 0; bottom: 0; width: min(360px, 92vw); pointer-events: auto;
        display: flex; flex-direction: column; background: var(--paper);
        border-left: 1.5px solid var(--ink); box-shadow: var(--shadow-hard);
        transform: translateX(calc(100% + 24px)); transition: transform 260ms var(--ease);
        will-change: transform;
      }
      .drawer.open { transform: translateX(0); }
      .dhead {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 14px 14px 10px;
      }
      .dhead .title { font-weight: 700; flex: 1; }
      .seg { display: inline-flex; flex-wrap: wrap; gap: 6px; flex-basis: 100%; margin-top: 4px; }
      .list { overflow: auto; padding: 8px 12px 16px; flex: 1; }
      .item {
        border: 1.5px solid var(--ink); border-radius: 9px; margin: 8px 0; padding: 10px;
        background: var(--paper-raised); cursor: pointer;
      }
      .item .meta { color: var(--ink-dim); font-size: 0.72rem; margin-top: 4px; }
      .item .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; }
      .empty { color: var(--ink-dim); padding: 14px; font-size: 0.8rem; }

      /* buttons */
      .btn {
        font: inherit; font-size: 0.8rem; font-weight: 600; cursor: pointer; pointer-events: auto;
        background: var(--paper); color: var(--ink); border: 1.5px solid var(--ink); border-radius: 8px;
        padding: 4px 9px; transition: transform 110ms var(--ease);
      }
      .btn:active { transform: scale(0.97); }
      .btn.primary { background: var(--accent); color: var(--paper); }
      .seg .btn.on { background: var(--ink); color: var(--paper); }

      /* fab — icon toolbar */
      .fab {
        position: fixed; right: 16px; bottom: 16px; pointer-events: auto; display: flex;
        align-items: center; gap: 8px; background: var(--paper); border: 1.5px solid var(--ink);
        border-radius: 999px; padding: 5px 13px; box-shadow: var(--shadow-hard);
      }
      .fab .btn { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; font-size: 0.95rem; line-height: 1; }
      .fab [data-act='pick'] { font-size: 1.25rem; }
      .drawer [data-close] { width: 28px; height: 28px; padding: 0; display: grid; place-items: center; font-size: 1rem; line-height: 1; }
      .btn[data-tip] { position: relative; }
      /* Centered by layout (auto margins), not translateX(-50%) — a transform
         leaves odd-width tips on a half-pixel and the text rasterizes soft.
         Whole-px font size + antialiased for the same reason: tiny light-on-dark
         text fringes under subpixel AA. */
      .btn[data-tip]::after,
      .nub[data-tip]::after {
        content: attr(data-tip); position: absolute; bottom: calc(100% + 8px);
        left: 0; right: 0; margin: 0 auto; width: max-content;
        transform: translateY(4px); background: var(--ink); color: var(--paper);
        font-size: 11px; white-space: nowrap; padding: 3px 7px; border-radius: 6px; opacity: 0;
        -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
        pointer-events: none; transition: opacity 120ms ease, transform 120ms var(--ease); z-index: 5;
      }
      .btn[data-tip]:hover::after,
      .nub[data-tip]:hover::after { opacity: 1; transform: translateY(0); }

      /* minimized bubble — the always-visible way back */
      .nub {
        position: fixed; right: 16px; bottom: 16px; pointer-events: auto; display: none;
        width: 44px; height: 44px; border-radius: 50%; place-items: center; cursor: pointer;
        background: var(--accent); color: var(--paper); font: inherit; font-weight: 700;
        font-size: 0.95rem; border: 1.5px solid var(--ink); box-shadow: var(--shadow-hard);
        -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
        transition: transform 110ms var(--ease);
      }
      .nub:active { transform: scale(0.96); }
      .layer.collapsed .fab { display: none; }
      .layer.collapsed #pins { display: none; }
      .layer.collapsed .nub { display: grid; }

      .toast {
        position: fixed; left: 0; right: 0; margin: 0 auto; width: max-content; bottom: 74px;
        transform: translateY(6px);
        background: var(--ink); color: var(--paper); font-size: 0.78rem; padding: 7px 13px;
        border-radius: 999px; pointer-events: none; opacity: 0;
        -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
        transition: opacity 180ms ease-out, transform 180ms var(--ease);
      }
      .toast.show { opacity: 1; transform: translateY(0); }

      @media (prefers-reduced-motion: reduce) {
        *, .drawer, .pop, .pin, .toast { transition: none !important; animation: none !important; }
      }
    </style>
    <div class="layer">
      <div class="hi" id="hi"></div>
      <div id="pins"></div>
      <div class="pop" id="pop"></div>
      <aside class="drawer" id="drawer"></aside>
      <div class="fab" id="fab">
        <button class="btn" data-act="pick" data-tip="New comment">✎</button>
        <button class="btn" data-act="log" data-tip="Comment log">☰</button>
        <button class="btn" data-act="min" data-tip="Minimize">–</button>
      </div>
      <button class="nub" id="nub" data-tip="Comments">✎</button>
      <div class="toast" id="toast"></div>
    </div>`;
  const $ = (id: string) => root.getElementById(id)!;
  const hi = $('hi'),
    pins = $('pins'),
    pop = $('pop'),
    drawer = $('drawer'),
    nub = $('nub'),
    toastEl = $('toast');
  const layer = root.querySelector('.layer')!;

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toast = (m: string) => {
    toastEl.textContent = m;
    toastEl.classList.add('show');
    // One timer, reset per toast — an earlier toast's timer must not cut a
    // later message (e.g. the publish-all summary) short.
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
  };

  const statusIcon = (s: Exclude<Status, 'all'>) => {
    const g = { open: '●', resolved: '✓', deleted: '✕' }[s];
    const col = { open: 'var(--live)', resolved: 'var(--ink-dim)', deleted: 'var(--warn)' }[s];
    return `<span class="sicon" title="${s}" style="color:${col}">${g}</span>`;
  };

  // ---- unified comment view -------------------------------------------------
  interface View {
    id: string;
    kind: 'draft' | 'published';
    text: string;
    page: string;
    selector: string;
    label: string;
    status: Exclude<Status, 'all'>;
    author: string;
    email: string;
    at: string;
    parentId: string;
  }
  const statusOfDoc = (d: BdDoc): Exclude<Status, 'all'> =>
    d.deleted ? 'deleted' : d.resolved ? 'resolved' : 'open';
  const views = (): View[] => [
    ...drafts.map((d) => ({
      id: d.id,
      kind: 'draft' as const,
      text: d.text,
      page: d.page,
      selector: d.selector,
      label: d.label,
      status: 'open' as const,
      author: 'you',
      email: 'draft — not published',
      at: timeAgo(d.createdAt),
      parentId: '',
    })),
    ...published.map((d) => ({
      id: d.id,
      kind: 'published' as const,
      text: String(d.text ?? ''),
      page: String(d.page ?? ''),
      selector: String(d.selector ?? ''),
      label: String(d.label ?? ''),
      status: statusOfDoc(d),
      author: String(d.createdBy ?? ''),
      email: String(d.createdByEmail ?? ''),
      at: timeAgo(d.createdAt),
      parentId: String(d.parentId ?? ''),
    })),
  ];
  // Page identity includes the query string — ?tab=billing is a different page
  // to comment on. Comments saved before this (or via the CLI) may carry a bare
  // pathname, so those still match anywhere on the path.
  const pageId = () => location.pathname + location.search;
  const here = (v: View) => v.page === pageId() || v.page === location.pathname;
  const shown = (v: View) => (filter === 'all' ? true : v.status === filter);
  const whoTag = (author: string, email: string) =>
    `<strong class="who" title="${escapeHtml(email || author)}">${escapeHtml(author)}</strong>`;

  // ---- pick mode ------------------------------------------------------------
  let picking = false;
  const setPick = (on: boolean) => {
    picking = on;
    hi.style.display = 'none';
    const b = $('fab').querySelector<HTMLElement>('[data-act="pick"]')!;
    b.classList.toggle('on', on);
    b.setAttribute('data-tip', on ? 'Cancel (Esc)' : 'New comment');
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
  };
  const onClick = (e: MouseEvent) => {
    if (!picking) return;
    const el = elAt(e.clientX, e.clientY);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    setPick(false);
    openCompose(el, e.clientX, e.clientY);
  };

  function placePop(x: number, y: number) {
    const w = 288,
      px = Math.min(Math.max(8, x), innerWidth - w - 8),
      py = Math.min(Math.max(8, y + 12), innerHeight - 260);
    pop.style.left = `${px}px`;
    pop.style.top = `${py}px`;
    pop.style.setProperty('--po', `${x - px}px ${y - py}px`);
  }
  function autogrow(ta: HTMLTextAreaElement) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }
  function openPop() {
    pop.classList.add('show');
    requestAnimationFrame(() => pop.classList.add('in'));
  }
  const closePop = () => {
    pop.classList.remove('in');
    setTimeout(() => pop.classList.remove('show'), 150);
  };

  // ---- new draft popover ----------------------------------------------------
  function openCompose(el: Element, x: number, y: number) {
    pop.innerHTML = `<div class="ctx">draft · ${escapeHtml(labelOf(el))}</div>
      <textarea placeholder="what about this element? (saved locally)"></textarea>
      <div class="row"><button class="btn" data-cancel>cancel</button><button class="btn primary" data-save>save draft</button></div>`;
    placePop(x, y);
    openPop();
    const ta = pop.querySelector('textarea')!;
    ta.focus();
    ta.addEventListener('input', () => autogrow(ta));
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
        selector: cssPath(el),
        label: labelOf(el),
        textSnippet: clean(el.textContent ?? '', 140),
        html: clean(el.outerHTML, 300),
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
      toast('draft saved');
    };
    ta.onkeydown = (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))
        pop.querySelector<HTMLElement>('[data-save]')!.click();
      if (ev.key === 'Escape') closePop();
    };
  }

  // ---- thread popover -------------------------------------------------------
  function openThread(v: View, x: number, y: number) {
    const head = `<div class="chead">${statusIcon(v.status)}${whoTag(v.author, v.email)}<span>· ${v.at}</span></div>`;
    const body = `<div class="txt">${escapeHtml(v.text)}</div>`;
    const replies = published
      .filter((p) => String(p.parentId ?? '') === v.id && !p.deleted)
      .map(
        (r) =>
          `<div class="reply"><div class="chead">${whoTag(String(r.createdBy ?? ''), String(r.createdByEmail ?? ''))}<span>· ${timeAgo(r.createdAt)}</span></div><div class="txt">${escapeHtml(String(r.text ?? ''))}</div></div>`,
      )
      .join('');
    const threadHtml = replies ? `<div class="thread">${replies}</div>` : '';
    const actions =
      v.kind === 'draft'
        ? `<div class="composebar"><div class="row"><button class="btn" data-del>delete draft</button><button class="btn" data-edit>edit</button><button class="btn primary" data-publish>publish</button></div></div>`
        : `<div class="composebar"><textarea placeholder="reply…"></textarea><div class="row"><button class="btn" data-del>delete</button><button class="btn" data-res>${v.status === 'resolved' ? 'reopen' : 'resolve'}</button><button class="btn primary" data-reply>reply</button></div></div>`;
    pop.innerHTML = `${head}${body}${threadHtml}${actions}`;
    placePop(x, y);
    openPop();
    const ta = pop.querySelector('textarea');
    if (ta) {
      ta.addEventListener('input', () => autogrow(ta));
      autogrow(ta);
      // Same keyboard affordances as compose: Cmd/Ctrl+Enter sends, Esc closes.
      ta.onkeydown = (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))
          pop.querySelector<HTMLElement>('[data-reply]')!.click();
        if (ev.key === 'Escape') closePop();
      };
    }
    if (v.kind === 'draft') {
      pop.querySelector<HTMLElement>('[data-del]')!.onclick = () => {
        drafts = drafts.filter((d) => d.id !== v.id);
        saveDrafts();
        closePop();
        render();
      };
      pop.querySelector<HTMLElement>('[data-edit]')!.onclick = () => openDraftEdit(v.id, x, y);
      pop.querySelector<HTMLElement>('[data-publish]')!.onclick = () => void publishDraft(v.id);
    } else {
      pop.querySelector<HTMLElement>('[data-reply]')!.onclick = async () => {
        const text = ta!.value.trim();
        if (!text) return;
        try {
          await action('reply', { id: v.id, text });
          closePop();
          toast('replied');
        } catch {
          toast('reply failed');
        }
      };
      pop.querySelector<HTMLElement>('[data-res]')!.onclick = async () => {
        try {
          await action(v.status === 'resolved' ? 'reopen' : 'resolve', { id: v.id });
          closePop();
        } catch {
          toast('failed');
        }
      };
      pop.querySelector<HTMLElement>('[data-del]')!.onclick = async () => {
        try {
          await action('delete', { id: v.id });
          closePop();
        } catch {
          toast('failed');
        }
      };
    }
  }

  // Editing gets its own clean compose-shaped view, never an input spliced
  // into the thread bubble — that's the state tangle html-grab hit and undid.
  function openDraftEdit(id: string, x: number, y: number) {
    const d = drafts.find((it) => it.id === id);
    if (!d) return;
    pop.innerHTML = `<div class="ctx">editing draft · ${escapeHtml(d.label)}</div>
      <textarea></textarea>
      <div class="row"><button class="btn" data-cancel>cancel</button><button class="btn primary" data-save>save</button></div>`;
    placePop(x, y);
    openPop();
    const ta = pop.querySelector('textarea')!;
    ta.value = d.text;
    ta.focus();
    autogrow(ta);
    ta.addEventListener('input', () => autogrow(ta));
    pop.querySelector<HTMLElement>('[data-cancel]')!.onclick = closePop;
    pop.querySelector<HTMLElement>('[data-save]')!.onclick = () => {
      const text = ta.value.trim();
      if (!text) {
        ta.focus();
        return;
      }
      d.text = text;
      saveDrafts();
      closePop();
      render();
      toast('draft updated');
    };
    ta.onkeydown = (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))
        pop.querySelector<HTMLElement>('[data-save]')!.click();
      if (ev.key === 'Escape') closePop();
    };
  }

  async function publishDraft(id: string): Promise<boolean> {
    const d = drafts.find((x) => x.id === id);
    if (!d) return true; // already gone — nothing left to publish
    try {
      await action('create', {
        text: d.text,
        page: d.page,
        selector: d.selector,
        label: d.label,
        textSnippet: d.textSnippet,
        html: d.html,
      });
      drafts = drafts.filter((x) => x.id !== id);
      saveDrafts();
      closePop();
      toast('published');
      render();
      return true;
    } catch {
      toast('publish failed — draft kept');
      return false;
    }
  }

  // ---- markdown export ------------------------------------------------------
  function draftsMarkdown(): string {
    let out = `# comment drafts on ${SITE}\n`;
    for (const d of drafts) {
      out += `\n## ${d.text}\n- page: \`${d.page}\`\n- selector: \`${d.selector}\`\n`;
      if (d.textSnippet) out += `- text: "${d.textSnippet}"\n`;
      if (d.dataAttrs) out += `- data: \`${d.dataAttrs}\`\n`;
    }
    return out;
  }

  /** The whole log — drafts and published, with status and replies. The widget
   *  twin of `brisk plugin comments export`. */
  function commentsMarkdown(): string {
    let out = `# comments on ${SITE}\n`;
    for (const v of views().filter((x) => !x.parentId)) {
      out += `\n## [${v.kind === 'draft' ? 'draft' : v.status}] ${v.text}\n`;
      out += `- by: ${v.author}\n- page: \`${v.page}\`\n`;
      if (v.selector) out += `- selector: \`${v.selector}\`\n`;
      for (const r of published.filter((p) => String(p.parentId ?? '') === v.id && !p.deleted))
        out += `- reply (${String(r.createdBy ?? '')}): ${String(r.text ?? '')}\n`;
    }
    return out;
  }

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
      () => toast('copied — paste to your agent'),
      () => {
        download(name, text);
        toast('clipboard blocked — downloaded instead');
      },
    );

  // ---- render ---------------------------------------------------------------
  const findTarget = (selector: string): Element | null => {
    try {
      return selector ? document.querySelector(selector) : null;
    } catch {
      return null; // invalid selector
    }
  };
  const placePin = (pin: HTMLElement, selector: string) => {
    const r = findTarget(selector)?.getBoundingClientRect();
    pin.style.left = `${(r?.left ?? 12) + 10}px`;
    pin.style.top = `${(r?.top ?? 12) + 10}px`;
  };

  /** Full rebuild — call when the data changes, not on scroll (rebuilding per
   *  scroll event restarts the pin-in animation and churns the DOM). */
  const pinRefs: { el: HTMLElement; selector: string }[] = [];
  function render() {
    pins.innerHTML = '';
    pinRefs.length = 0;
    for (const v of views().filter((v) => here(v) && !v.parentId && shown(v))) {
      const target = findTarget(v.selector);
      const pin = document.createElement('div');
      pin.className = `pin ${v.kind === 'draft' ? 'draft' : v.status}${!target && v.selector ? ' detached' : ''}`;
      pin.textContent = v.kind === 'draft' ? '✎' : '●';
      placePin(pin, v.selector);
      pin.onclick = (e) => {
        e.stopPropagation();
        openThread(v, e.clientX, e.clientY);
      };
      pins.appendChild(pin);
      pinRefs.push({ el: pin, selector: v.selector });
    }
    if (drawer.classList.contains('open')) renderPanel();
    updateNub();
  }

  /** Scroll/resize path: move the existing pins, coalesced to one rAF. */
  let repositionQueued = false;
  const scheduleReposition = () => {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      for (const { el, selector } of pinRefs) placePin(el, selector);
    });
  };

  const dotColor = (s: string) =>
    s === 'resolved' ? 'var(--ink-dim)' : s === 'deleted' ? 'var(--warn)' : 'var(--live)';

  function renderPanel() {
    const chips = (['open', 'resolved', 'deleted', 'all'] as Status[])
      .map((s) => `<button class="btn ${s === filter ? 'on' : ''}" data-f="${s}">${s}</button>`)
      .join('');
    const rows = views()
      .filter((v) => !v.parentId && shown(v))
      .map(
        (v) =>
          `<div class="item" data-id="${escapeHtml(v.id)}" data-kind="${v.kind}"><div class="txt"><span class="dot" style="background:${dotColor(v.status)}"></span>${escapeHtml(v.text.slice(0, 90))}</div><div class="meta">${whoTag(v.author, v.email)} · ${v.status} · ${escapeHtml(v.page)}</div></div>`,
      )
      .join('');
    const drafts0 = drafts.length;
    drawer.innerHTML = `<div class="dhead">
        <span class="title">Comments</span>
        <button class="btn" data-close aria-label="close">✕</button>
        <div class="seg">${chips}</div>
        <div class="seg"><button class="btn" data-copyall>copy log as md</button>${drafts0 ? `<button class="btn" data-copy>copy ${drafts0} draft(s) as md</button><button class="btn primary" data-puball>publish all</button>` : ''}</div>
      </div>
      <div class="list">${rows || `<div class="empty">no ${filter} comments</div>`}</div>`;
    drawer.querySelector<HTMLElement>('[data-close]')!.onclick = toggleDrawer;
    drawer.querySelectorAll<HTMLElement>('[data-f]').forEach((b) => {
      b.onclick = () => {
        filter = b.dataset.f as Status;
        localStorage.setItem(key('filter'), filter);
        render();
      };
    });
    drawer.querySelector<HTMLElement>('[data-copyall]')!.onclick = () =>
      void clip(`comments-${SITE}.md`, commentsMarkdown());
    const copy = drawer.querySelector<HTMLElement>('[data-copy]');
    if (copy) copy.onclick = () => void clip(`comment-drafts-${SITE}.md`, draftsMarkdown());
    const puball = drawer.querySelector<HTMLElement>('[data-puball]');
    if (puball)
      puball.onclick = async () => {
        let ok = 0,
          failed = 0;
        for (const d of [...drafts]) (await publishDraft(d.id)) ? ok++ : failed++;
        toast(
          failed
            ? `published ${ok}/${ok + failed} — failed drafts kept`
            : `published ${ok} draft${ok === 1 ? '' : 's'}`,
        );
      };
    drawer.querySelectorAll<HTMLElement>('.item').forEach((item) => {
      item.onclick = () => {
        const v = views().find((x) => x.id === item.dataset.id && x.kind === item.dataset.kind);
        if (!v) return;
        let target: Element | null = null;
        try {
          target = v.selector ? document.querySelector(v.selector) : null;
        } catch {
          /* ignore */
        }
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const r = target?.getBoundingClientRect();
        openThread(v, r?.left ?? innerWidth / 2, r?.top ?? innerHeight / 2);
      };
    });
  }

  let drawerOpen = false;
  function toggleDrawer() {
    drawerOpen = !drawerOpen;
    renderPanel();
    drawer.classList.toggle('open', drawerOpen);
  }

  // ---- minimize / hide / restore --------------------------------------------
  // Minimize collapses to a small bubble that's always visible — click it to
  // reopen. Shift+C fully hides everything (bubble included) for clean shots.
  function updateNub() {
    const open = views().filter((v) => !v.parentId && v.status === 'open').length;
    nub.textContent = open > 0 ? String(open) : '✎';
    nub.setAttribute(
      'data-tip',
      open > 0 ? `${open} open comment${open === 1 ? '' : 's'}` : 'Comments',
    );
  }
  function applyCollapsed() {
    layer.classList.toggle('collapsed', collapsed);
    if (collapsed) {
      closePop();
      if (drawerOpen) toggleDrawer();
    }
    updateNub();
  }
  function applyHidden() {
    host.style.display = hidden ? 'none' : '';
  }
  const fab = $('fab');
  fab.querySelector<HTMLElement>('[data-act="pick"]')!.onclick = () => setPick(!picking);
  fab.querySelector<HTMLElement>('[data-act="log"]')!.onclick = toggleDrawer;
  fab.querySelector<HTMLElement>('[data-act="min"]')!.onclick = () => {
    collapsed = true;
    localStorage.setItem(key('collapsed'), '1');
    applyCollapsed();
  };
  nub.onclick = () => {
    collapsed = false;
    localStorage.setItem(key('collapsed'), '0');
    applyCollapsed();
  };

  // The hotkey survives hiding: it toggles the whole host in and out.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setPick(false);
      closePop();
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
      localStorage.setItem(key('hidden'), hidden ? '1' : '0');
      applyHidden();
    }
  };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  // Reposition pins on scroll; the popover stays put (it's fixed) so a scrolling
  // textarea can't dismiss it.
  addEventListener('scroll', scheduleReposition, true);
  addEventListener('resize', scheduleReposition, true);
  // History-routed navigation changes the page identity — re-filter the pins.
  addEventListener('popstate', () => render());

  // ---- boot -----------------------------------------------------------------
  applyHidden();
  applyCollapsed();
  render();
  void refreshPublished();
})();
