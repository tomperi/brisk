import type { DbEvent, Rooms } from '../types';
import type { User } from '../../env';

/** Durable Object implementation of `Rooms`: one DO instance per site,
 *  addressed by name. Encodes the user into the upgrade request the DO reads. */
export function cloudflareRooms(ns: DurableObjectNamespace): Rooms {
  const stub = (site: string) => ns.get(ns.idFromName(site));
  return {
    async publish(site: string, event: DbEvent) {
      await stub(site).fetch('https://room/publish', {
        method: 'POST',
        body: JSON.stringify(event),
      });
    },
    connect(site: string, request: Request, user: User) {
      const headers = new Headers(request.headers);
      headers.set('x-brisk-user', JSON.stringify(user));
      return stub(site).fetch(new Request(request.url, { headers }));
    },
  };
}
