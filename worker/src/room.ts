import { DurableObject } from 'cloudflare:workers';
import type { Env, User } from './env';
import type { DbEvent } from './platform/types';
import { RoomLogic, type ConnState, type RoomPort } from './room-logic';

/**
 * One Durable Object per site fans out everything realtime. This class is now a
 * thin shell: it owns the Cloudflare-specific transport (websocket hibernation,
 * attachment serialization) and delegates all fan-out to a platform-neutral
 * RoomLogic. Idle rooms still cost nothing (hibernation). Protocol:
 * ../docs/realtime-protocol.md.
 */
export class SiteRoom extends DurableObject<Env> implements RoomPort<WebSocket> {
  private readonly room = new RoomLogic<WebSocket>(this);

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/publish') {
      this.room.publishDb(await request.json<DbEvent>());
      return Response.json({ ok: true });
    }

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket', { status: 426 });
    }
    const user = JSON.parse(request.headers.get('x-brisk-user') ?? '{}') as User;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    this.room.hello(server, user);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string') return;
    this.room.handleMessage(ws, raw);
  }

  override webSocketClose(ws: WebSocket): void {
    this.room.close(ws);
  }

  // ---- RoomPort<WebSocket>: hibernation-aware connection access ----------
  // Every accepted socket gets an attachment up front, and hibernation
  // preserves it — so reading it back is infallible.
  all(): Iterable<WebSocket> {
    return this.ctx.getWebSockets();
  }
  send(ws: WebSocket, data: string): void {
    ws.send(data);
  }
  getState(ws: WebSocket): ConnState {
    return ws.deserializeAttachment() as ConnState;
  }
  setState(ws: WebSocket, state: ConnState): void {
    ws.serializeAttachment(state);
  }
}
