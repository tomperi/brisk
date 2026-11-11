import { anchorFields, anchorOfRecord } from './anchor';
import { seenDocId } from './inbox';
import { buildThreads, type Draft, type StoredDoc, type Thread } from './threads';

type Handlers = {
  onCreate?: (d: StoredDoc) => void;
  onUpdate?: (d: StoredDoc) => void;
  onDelete?: (id: string) => void;
};
/** The slice of the SDK the widget uses. It is bound to the site of its own page. */
export type Brisk = {
  db: {
    collection(name: string): { subscribe(h: Handlers): () => void };
  };
};

export type Action = 'create' | 'reply' | 'react' | 'delete' | 'resolve' | 'reopen';

/** The one place that knows the `brisk:comments:<site>:<k>` localStorage format. */
export const storageKey = (site: string, k: string): string => `brisk:comments:${site}:${k}`;

export type Me = { email: string; name: string };

/** One site's comments as this browser holds them: the only reader and writer
 *  of that site's published list, read state, drafts and realtime feed. */
export interface SiteComments {
  readonly site: string;
  /** Settles when the first read of the published list ends, ok or not. */
  readonly loaded: Promise<void>;
  /** Drafts and published threads, numbered within this site. */
  threads(): Thread[];
  drafts(): readonly Draft[];
  /** Without realtime, re-reads the list after the write so it shows. */
  act(name: Action, args: Record<string, string>): Promise<StoredDoc>;
  saveDraft(d: Draft): void;
  dropDrafts(ids: readonly string[] | 'all'): void;
  /** Publishes a draft and drops it; null when no such draft is left. */
  publish(draftId: string): Promise<StoredDoc | null>;
  /** Shows the stamp at once and rolls it back if the write fails. '' = unread. */
  markSeen(threadId: string, stamp: string): Promise<void>;
  refresh(): Promise<void>;
  /** The realtime feed. A change of source re-reads once; null = none. */
  listen(sdk: Brisk | null): void;
}

const COLLECTION = '_plugin:comments';
const SEEN = '_plugin:comments:seen';

/** `changed` fires when server data or a read-state write lands; draft edits
 *  are the caller's own, so it renders after them itself. */
export function siteComments(
  site: string,
  ctx: { me: Promise<Me | null>; changed: () => void },
): SiteComments {
  const headers = { 'x-brisk-site': site };
  const draftsKey = storageKey(site, 'drafts');
  let drafts: Draft[] = (() => {
    try {
      return JSON.parse(localStorage.getItem(draftsKey) || '[]') as Draft[];
    } catch {
      return [];
    }
  })();
  const saveDrafts = () => localStorage.setItem(draftsKey, JSON.stringify(drafts));

  let published: StoredDoc[] = [];
  let me: Me = { email: '', name: '' };
  let serverSeen: Record<string, string> = {};
  const pendingSeen = new Map<string, string>();
  let seenReady = false;
  let source: Brisk | null | undefined;
  let unsubscribe: (() => void)[] = [];
  const publishing = new Map<string, Promise<StoredDoc | null>>();

  const readComments = async () => {
    const res = await fetch(`/api/db/${COLLECTION}?limit=500&sort=-created`, { headers });
    if (!res.ok) return;
    published = ((await res.json()) as { docs: StoredDoc[] }).docs;
    ctx.changed();
  };

  const myDocId = () => seenDocId(me.email);
  /** A list, not `GET /:id`: until you first read a thread you have no doc, and
   *  that 404 lands in the console. Past one full page, ask for the doc by id. */
  const readMySeen = async (): Promise<StoredDoc | undefined> => {
    const res = await fetch(`/api/db/${SEEN}?limit=500`, { headers });
    if (!res.ok) throw new Error(`seen state: ${res.status}`);
    const { docs } = (await res.json()) as { docs: StoredDoc[] };
    const mine = docs.find((d) => d.id === myDocId());
    if (mine || docs.length < 500) return mine;
    const one = await fetch(`/api/db/${SEEN}/${encodeURIComponent(myDocId())}`, { headers });
    if (!one.ok && one.status !== 404) throw new Error(`seen state: ${one.status}`);
    return one.ok ? ((await one.json()) as StoredDoc) : undefined;
  };
  const applySeen = (doc: StoredDoc) => {
    if (doc.id !== myDocId()) return;
    serverSeen = { ...(doc.seen as Record<string, string> | undefined) };
    ctx.changed();
  };
  const readSeen = async () => {
    const who = await ctx.me;
    if (!who) return;
    me = who;
    try {
      serverSeen = { ...((await readMySeen())?.seen as Record<string, string> | undefined) };
      seenReady = true;
      ctx.changed();
    } catch (err) {
      console.warn('[comments] unread state unavailable:', err);
    }
  };

  const post = async (name: string, args: Record<string, string>): Promise<StoredDoc> => {
    const res = await fetch(`/api/plugins/comments/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `site` last: a caller's own field must not send the write to another site.
      body: JSON.stringify({ args: { ...args, site } }),
    });
    if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
    return ((await res.json()) as { result: StoredDoc }).result;
  };
  const act = async (name: Action, args: Record<string, string>) => {
    const doc = await post(name, args);
    if (!source) void readComments();
    return doc;
  };

  const refresh = async () => {
    await Promise.all([readComments(), readSeen()]);
  };
  const loaded = readComments().catch((err: unknown) =>
    console.warn('[comments] comments unavailable:', err),
  );
  void readSeen();

  return {
    site,
    loaded,
    threads() {
      const seen = { ...serverSeen, ...Object.fromEntries(pendingSeen) };
      const out = buildThreads({ site, drafts, docs: published, seen, me: me.email });
      if (!seenReady) for (const t of out) t.unread = false;
      return out;
    },
    drafts: () => drafts,
    act,
    saveDraft(d) {
      const i = drafts.findIndex((x) => x.id === d.id);
      drafts = i < 0 ? [...drafts, d] : drafts.map((x, j) => (j === i ? d : x));
      saveDrafts();
    },
    dropDrafts(ids) {
      drafts = ids === 'all' ? [] : drafts.filter((d) => !ids.includes(d.id));
      saveDrafts();
    },
    publish(draftId) {
      const inFlight = publishing.get(draftId);
      if (inFlight) return inFlight;
      const d = drafts.find((x) => x.id === draftId);
      if (!d) return Promise.resolve(null);
      const p = act('create', {
        text: d.text,
        page: d.page,
        ...anchorFields(anchorOfRecord(d)),
        label: d.label,
        textSnippet: d.textSnippet,
        html: d.html,
      })
        .then((doc) => {
          drafts = drafts.filter((x) => x.id !== draftId);
          saveDrafts();
          return doc;
        })
        .finally(() => publishing.delete(draftId));
      publishing.set(draftId, p);
      return p;
    },
    async markSeen(threadId, stamp) {
      if (!seenReady || pendingSeen.get(threadId) === stamp) return;
      pendingSeen.set(threadId, stamp);
      ctx.changed();
      try {
        const doc = await post(stamp ? 'seen' : 'unseen', { id: threadId });
        if (pendingSeen.get(threadId) === stamp) pendingSeen.delete(threadId);
        applySeen(doc);
      } catch (err) {
        if (pendingSeen.get(threadId) === stamp) pendingSeen.delete(threadId);
        ctx.changed();
        throw err;
      }
    },
    refresh,
    listen(sdk) {
      if (sdk === source) return;
      const first = source === undefined;
      for (const off of unsubscribe) off();
      unsubscribe = [];
      source = sdk;
      if (sdk) {
        unsubscribe = [
          sdk.db.collection(COLLECTION).subscribe({
            onCreate: (d) => {
              published = [d, ...published.filter((p) => p.id !== d.id)];
              ctx.changed();
            },
            onUpdate: (d) => {
              published = published.map((p) => (p.id === d.id ? d : p));
              ctx.changed();
            },
            onDelete: (id) => {
              published = published.filter((p) => p.id !== id);
              ctx.changed();
            },
          }),
          sdk.db.collection(SEEN).subscribe({ onCreate: applySeen, onUpdate: applySeen }),
        ];
      }
      if (!first) void refresh();
    },
  };
}
