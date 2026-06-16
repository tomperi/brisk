import { DurableObject } from 'cloudflare:workers';
import type { Env, User } from './env';
import type { DbEvent } from './platform/types';

/** What each socket remembers across hibernation. */
interface Attachment {
  user: User;
  /** Collections this socket subscribed to for db change events. */
  subs: string[];
  /** Channels this socket joined for messages + presence. */
  channels: string[];
}

type ClientMessage =
  | { t: 'db:sub' | 'db:unsub'; collection: string }
  | { t: 'join' | 'leave'; channel: string }
  | { t: 'send'; channel: string; data: unknown };

/**
 * One Durable Object per site fans out everything realtime: db change events,
 * channel messages, and presence. Uses websocket hibernation, so an idle room
 * costs nothing.
 */
export class SiteRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/publish') {
      this.broadcastDb(await request.json<DbEvent>());
      return Response.json({ ok: true });
    }

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket', { status: 426 });
    }
    const user = JSON.parse(request.headers.get('x-brisk-user') ?? '{}') as User;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    setAttachment(server, { user, subs: [], channels: [] });
    server.send(JSON.stringify({ t: 'hello', you: user }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string') return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    const att = getAttachment(ws);

    switch (msg.t) {
      case 'db:sub':
        if (!att.subs.includes(msg.collection)) att.subs.push(msg.collection);
        setAttachment(ws, att);
        break;
      case 'db:unsub':
        att.subs = att.subs.filter((c) => c !== msg.collection);
        setAttachment(ws, att);
        break;
      case 'join':
        if (!att.channels.includes(msg.channel)) att.channels.push(msg.channel);
        setAttachment(ws, att);
        this.broadcastPresence(msg.channel);
        break;
      case 'leave':
        att.channels = att.channels.filter((c) => c !== msg.channel);
        setAttachment(ws, att);
        this.broadcastPresence(msg.channel);
        break;
      case 'send':
        this.broadcastToChannel(
          msg.channel,
          { t: 'msg', channel: msg.channel, data: msg.data, from: att.user },
          ws,
        );
        break;
    }
  }

  override webSocketClose(ws: WebSocket): void {
    for (const channel of getAttachment(ws).channels) this.broadcastPresence(channel, ws);
  }

  private broadcastDb(event: DbEvent): void {
    const payload = JSON.stringify({ t: 'db', ...event });
    for (const ws of this.ctx.getWebSockets()) {
      if (getAttachment(ws).subs.includes(event.collection)) ws.send(payload);
    }
  }

  private broadcastToChannel(channel: string, message: unknown, except?: WebSocket): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except && getAttachment(ws).channels.includes(channel)) ws.send(payload);
    }
  }

  /** Everyone in a channel gets the fresh member list on every join/leave. */
  private broadcastPresence(channel: string, leaving?: WebSocket): void {
    const members: User[] = [];
    const seen = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === leaving) continue;
      const att = getAttachment(ws);
      if (att.channels.includes(channel) && !seen.has(att.user.email)) {
        seen.add(att.user.email);
        members.push(att.user);
      }
    }
    this.broadcastToChannel(channel, { t: 'presence', channel, members }, leaving);
  }
}

// Every accepted socket gets an attachment up front, and hibernation
// preserves it — so reading it back is infallible.
function getAttachment(ws: WebSocket): Attachment {
  return ws.deserializeAttachment() as Attachment;
}

function setAttachment(ws: WebSocket, att: Attachment): void {
  ws.serializeAttachment(att);
}
