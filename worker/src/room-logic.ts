import type { User } from './env';
import type { DbEvent } from './platform/types';

/** What each connection remembers: identity plus its subscriptions. */
export interface ConnState {
  user: User;
  /** Collections subscribed for db change events. */
  subs: string[];
  /** Channels joined for messages + presence. */
  channels: string[];
}

type ClientMessage =
  | { t: 'db:sub' | 'db:unsub'; collection: string }
  | { t: 'join' | 'leave'; channel: string }
  | { t: 'send'; channel: string; data: unknown };

/**
 * Transport-neutral access to the connections in one room. Cloudflare's DO
 * implements this over hibernatable WebSockets (state via serialize/deserialize
 * attachment); a Node server implements it over in-memory sockets and a Map.
 * RoomLogic never touches a socket except through this port — identity is the
 * connection reference `C` itself, so `===`/`!==` must be stable per socket.
 */
export interface RoomPort<C> {
  all(): Iterable<C>;
  send(conn: C, data: string): void;
  getState(conn: C): ConnState;
  setState(conn: C, state: ConnState): void;
}

/**
 * The platform-neutral realtime brain: db-event fan-out, channel messages, and
 * presence. One instance per room, driven by a thin transport shell. Protocol:
 * ../docs/realtime-protocol.md — message shapes here are frozen.
 */
export class RoomLogic<C> {
  constructor(private readonly port: RoomPort<C>) {}

  /** Register a freshly-connected socket and greet it. */
  hello(conn: C, user: User): void {
    this.port.setState(conn, { user, subs: [], channels: [] });
    this.port.send(conn, JSON.stringify({ t: 'hello', you: user }));
  }

  /** Handle one client text frame. (Non-string frames are dropped by the shell.) */
  handleMessage(conn: C, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    const att = this.port.getState(conn);

    switch (msg.t) {
      case 'db:sub':
        if (!att.subs.includes(msg.collection)) att.subs.push(msg.collection);
        this.port.setState(conn, att);
        break;
      case 'db:unsub':
        att.subs = att.subs.filter((c) => c !== msg.collection);
        this.port.setState(conn, att);
        break;
      case 'join':
        if (!att.channels.includes(msg.channel)) att.channels.push(msg.channel);
        this.port.setState(conn, att);
        this.broadcastPresence(msg.channel);
        break;
      case 'leave':
        att.channels = att.channels.filter((c) => c !== msg.channel);
        this.port.setState(conn, att);
        this.broadcastPresence(msg.channel);
        break;
      case 'send':
        this.broadcastToChannel(
          msg.channel,
          { t: 'msg', channel: msg.channel, data: msg.data, from: att.user },
          conn,
        );
        break;
    }
  }

  /** A socket went away: refresh presence for each channel it was in. */
  close(conn: C): void {
    for (const channel of this.port.getState(conn).channels) {
      this.broadcastPresence(channel, conn);
    }
  }

  /** Fan a db change event out to its subscribers. */
  publishDb(event: DbEvent): void {
    const payload = JSON.stringify({ t: 'db', ...event });
    for (const conn of this.port.all()) {
      if (this.port.getState(conn).subs.includes(event.collection)) {
        this.port.send(conn, payload);
      }
    }
  }

  private broadcastToChannel(channel: string, message: unknown, except?: C): void {
    const payload = JSON.stringify(message);
    for (const conn of this.port.all()) {
      if (conn !== except && this.port.getState(conn).channels.includes(channel)) {
        this.port.send(conn, payload);
      }
    }
  }

  /** Everyone in a channel gets the fresh member list on every join/leave/close. */
  private broadcastPresence(channel: string, leaving?: C): void {
    const members: User[] = [];
    const seen = new Set<string>();
    for (const conn of this.port.all()) {
      if (conn === leaving) continue;
      const att = this.port.getState(conn);
      if (att.channels.includes(channel) && !seen.has(att.user.email)) {
        seen.add(att.user.email);
        members.push(att.user);
      }
    }
    this.broadcastToChannel(channel, { t: 'presence', channel, members }, leaving);
  }
}
