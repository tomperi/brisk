/**
 * The Brisk browser SDK. Served at /brisk.js on every site:
 *
 *   <script src="/brisk.js"></script>
 *   const posts = brisk.db.collection('posts');
 *   await posts.create({ title: 'Hello' });
 *
 * Zero config, zero API keys: requests stay on the site's own origin and the
 * server already knows who you are.
 */

export interface Doc {
  id: string;
  createdAt: string;
  updatedAt: string;
  [field: string]: unknown;
}

export interface User {
  email: string;
  name: string;
  picture?: string;
}

export interface UploadedFile {
  name: string;
  url: string;
  size: number;
  type: string;
}

export interface SubscribeHandlers {
  onCreate?: (doc: Doc) => void;
  onUpdate?: (doc: Doc) => void;
  onDelete?: (id: string) => void;
}

type ServerMessage =
  | { t: 'hello'; you: User }
  | { t: 'db'; collection: string; event: 'create' | 'update' | 'delete'; doc?: Doc; id?: string }
  | { t: 'msg'; channel: string; data: unknown; from: User }
  | { t: 'presence'; channel: string; members: User[] };

// ---- site + transport -----------------------------------------------------

/** In path mode (/s/<site>/...) the page must tell the server its site. */
const PATH_MODE = /^\/s\/([a-z0-9-]+)(\/|$)/.exec(location.pathname);

export const site: string | null = PATH_MODE?.[1] ?? null;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (site) headers.set('x-brisk-site', site);
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`brisk: ${init.method ?? 'GET'} ${path} → ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---- realtime socket (lazy, shared, self-healing) ---------------------------

const dbSubs = new Map<string, Set<SubscribeHandlers>>();
interface ChannelState {
  message: Set<(data: unknown, from: User) => void>;
  presence: Set<(members: User[]) => void>;
  members: User[];
}
const channels = new Map<string, ChannelState>();

let ws: WebSocket | null = null;
let wsReady = false;
let backoff = 500;
const sendQueue: object[] = [];

function wsSend(msg: object): void {
  if (wsReady) ws!.send(JSON.stringify(msg));
  else {
    sendQueue.push(msg);
    connect();
  }
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/api/ws${site ? `?site=${site}` : ''}`);

  ws.onopen = () => {
    wsReady = true;
    backoff = 500;
    // Re-establish everything after a (re)connect.
    for (const collection of dbSubs.keys()) ws!.send(JSON.stringify({ t: 'db:sub', collection }));
    for (const channel of channels.keys()) ws!.send(JSON.stringify({ t: 'join', channel }));
    for (const msg of sendQueue.splice(0)) ws!.send(JSON.stringify(msg));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string) as ServerMessage;
    if (msg.t === 'db') {
      for (const handler of dbSubs.get(msg.collection) ?? []) {
        if (msg.event === 'create' && msg.doc) handler.onCreate?.(msg.doc);
        if (msg.event === 'update' && msg.doc) handler.onUpdate?.(msg.doc);
        if (msg.event === 'delete' && msg.id) handler.onDelete?.(msg.id);
      }
    } else if (msg.t === 'msg') {
      for (const fn of channels.get(msg.channel)?.message ?? []) fn(msg.data, msg.from);
    } else if (msg.t === 'presence') {
      const state = channels.get(msg.channel);
      if (!state) return;
      state.members = msg.members;
      for (const fn of state.presence) fn(msg.members);
    }
  };

  ws.onclose = () => {
    wsReady = false;
    if (dbSubs.size || channels.size || sendQueue.length) {
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    }
  };
}

// ---- db ---------------------------------------------------------------------

export const db = {
  collection(name: string) {
    const base = `/api/db/${encodeURIComponent(name)}`;
    return {
      /** List docs, oldest first. `{ sort: '-created' }` for newest first. */
      async list(opts: { limit?: number; sort?: string } = {}): Promise<Doc[]> {
        const params = new URLSearchParams();
        if (opts.limit) params.set('limit', String(opts.limit));
        if (opts.sort) params.set('sort', opts.sort);
        const query = params.size ? `?${params}` : '';
        return (await api<{ docs: Doc[] }>(`${base}${query}`)).docs;
      },
      get: (id: string) => api<Doc>(`${base}/${encodeURIComponent(id)}`),
      create: (fields: Record<string, unknown>) =>
        api<Doc>(base, { method: 'POST', body: JSON.stringify(fields) }),
      update: (id: string, fields: Record<string, unknown>) =>
        api<Doc>(`${base}/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(fields),
        }),
      delete: (id: string) =>
        api<{ ok: boolean }>(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      /** Live changes for this collection. Returns an unsubscribe function. */
      subscribe(handlers: SubscribeHandlers): () => void {
        let set = dbSubs.get(name);
        if (!set) {
          set = new Set();
          dbSubs.set(name, set);
          wsSend({ t: 'db:sub', collection: name });
        }
        set.add(handlers);
        return () => {
          set.delete(handlers);
          if (!set.size) {
            dbSubs.delete(name);
            wsSend({ t: 'db:unsub', collection: name });
          }
        };
      },
    };
  },
};

// ---- fs ---------------------------------------------------------------------

export const fs = {
  /** Upload File(s) or a FileList; returns their permanent URLs. */
  async upload(input: File | File[] | FileList): Promise<UploadedFile[]> {
    const files = input instanceof File ? [input] : [...input];
    const form = new FormData();
    for (const file of files) form.append('files', file);
    return (await api<{ files: UploadedFile[] }>('/api/fs/upload', { method: 'POST', body: form }))
      .files;
  },
};

// ---- ai ---------------------------------------------------------------------

export interface ChatOptions {
  system?: string;
  model?: string;
  maxTokens?: number;
}

export const ai = {
  /** `brisk.ai.chat('summarize my tasks')` or pass a messages array. */
  chat(
    prompt: string | { role: 'user' | 'assistant'; content: string }[],
    opts: ChatOptions = {},
  ): Promise<{ text: string; model: string; provider: string }> {
    const messages = typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt;
    return api('/api/ai/chat', { method: 'POST', body: JSON.stringify({ ...opts, messages }) });
  },
};

// ---- identity ----------------------------------------------------------------

let cachedMe: Promise<User> | null = null;

/** Who's looking at the page. Free, thanks to platform-level auth. */
export function me(): Promise<User> {
  cachedMe ??= api<User>('/api/me');
  return cachedMe;
}

// ---- channels -----------------------------------------------------------------

/**
 * Realtime channels with presence — multiplayer in three lines:
 *
 *   const room = brisk.channel('cursors');
 *   room.on('message', (data, from) => render(from.email, data));
 *   onmousemove = (e) => room.send({ x: e.clientX, y: e.clientY });
 */
export function channel(name: string) {
  let state = channels.get(name);
  if (!state) {
    state = { message: new Set(), presence: new Set(), members: [] };
    channels.set(name, state);
    wsSend({ t: 'join', channel: name });
  }
  const current = state;

  return {
    send: (data: unknown) => wsSend({ t: 'send', channel: name, data }),
    on(event: 'message' | 'presence', fn: (...args: never[]) => void): () => void {
      const set = event === 'message' ? current.message : current.presence;
      set.add(fn as never);
      return () => set.delete(fn as never);
    },
    get members(): User[] {
      return current.members;
    },
    leave(): void {
      channels.delete(name);
      wsSend({ t: 'leave', channel: name });
    },
  };
}
