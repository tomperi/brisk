import type { Cache } from '../types';

/** Wraps the Cloudflare global edge cache. Keys are URL strings; the original
 *  code already keyed on a query-stripped URL with a `__site` discriminator. */
export function cloudflareCache(): Cache {
  const cache = caches.default;
  return {
    async match(key: string) {
      return (await cache.match(new Request(key))) ?? null;
    },
    async put(key: string, response: Response) {
      await cache.put(new Request(key), response);
    },
  };
}
