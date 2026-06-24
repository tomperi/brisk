import type { Cache } from '../types';

interface Entry {
  body: ArrayBuffer;
  headers: [string, string][];
  expires: number;
}

/** In-process response cache for the visitor edge-cache path. Single-pod; not
 *  shared across replicas (a Redis-backed cache is the multi-replica opt-in).
 *  Bounded by entry count to avoid unbounded growth in a long-lived process. */
export function createMemoryCache(maxEntries = 1000): Cache {
  const store = new Map<string, Entry>();
  const ttlFromHeaders = (h: Headers): number => {
    const m = (h.get('cache-control') ?? '').match(/max-age=(\d+)/);
    return m ? Number(m[1]) * 1000 : 0;
  };
  return {
    async match(key: string): Promise<Response | null> {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expires <= Date.now()) {
        store.delete(key);
        return null;
      }
      return new Response(hit.body.slice(0), { headers: new Headers(hit.headers) });
    },
    async put(key: string, response: Response): Promise<void> {
      const ttl = ttlFromHeaders(response.headers);
      if (ttl <= 0) return; // only cache responses that asked to be cached
      const body = await response.arrayBuffer();
      if (store.size >= maxEntries) store.delete(store.keys().next().value as string);
      store.set(key, {
        body,
        headers: [...response.headers.entries()],
        expires: Date.now() + ttl,
      });
    },
  };
}
