import { upgradeWebSocket } from '@hono/node-server';
import type { Context, MiddlewareHandler } from 'hono';
import type { WSContext } from 'hono/ws';
import type { AppEnv, User } from '../../env';
import { isValidSiteName } from '../../sites';
import { RoomLogic, type ConnState, type RoomPort } from '../../room-logic';
import type { DbEvent, Rooms } from '../types';

/** One connection: its live socket + in-memory state. WSContext identity is
 *  stable per socket, so NodeConn is 1:1 with it and safe as the RoomLogic key. */
interface NodeConn {
  ctx: WSContext;
  state: ConnState;
}

class NodeRoom implements RoomPort<NodeConn> {
  readonly conns = new Set<NodeConn>();
  readonly logic = new RoomLogic<NodeConn>(this);
  all(): Iterable<NodeConn> {
    return this.conns;
  }
  send(c: NodeConn, data: string): void {
    if (c.ctx.readyState === 1) c.ctx.send(data); // 1 === OPEN
  }
  getState(c: NodeConn): ConnState {
    return c.state;
  }
  setState(c: NodeConn, s: ConnState): void {
    c.state = s;
  }
}

export interface NodeRooms extends Rooms {
  /** The Hono handler the Node entry mounts on /api/ws (overrides createApp's default). */
  wsRoute: MiddlewareHandler<AppEnv>;
}

/**
 * In-process Rooms: one NodeRoom per site in a Map, fan-out via the shared
 * RoomLogic. publish() reaches subscribers in-process; connect() is unused on
 * Node (the upgrade is handled by the wsRoute middleware on the 'upgrade' event).
 */
export function createNodeRooms(): NodeRooms {
  const rooms = new Map<string, NodeRoom>();
  const roomFor = (site: string): NodeRoom => {
    let r = rooms.get(site);
    if (!r) rooms.set(site, (r = new NodeRoom()));
    return r;
  };

  const wsRoute = upgradeWebSocket((c: Context<AppEnv>) => {
    // Runs when the upgrade is routed; auth + site middleware have already run.
    const user = c.var.user as User;
    const fromQuery = c.req.query('site');
    const site = fromQuery && isValidSiteName(fromQuery) ? fromQuery : c.var.site;
    const room = roomFor(site);
    let conn: NodeConn;
    return {
      onOpen(_evt, ws) {
        conn = { ctx: ws, state: { user, subs: [], channels: [] } };
        room.conns.add(conn);
        room.logic.hello(conn, user);
      },
      onMessage(evt, _ws) {
        if (typeof evt.data === 'string') room.logic.handleMessage(conn, evt.data);
      },
      onClose() {
        if (!conn) return;
        room.logic.close(conn);
        room.conns.delete(conn);
        if (room.conns.size === 0) rooms.delete(site); // bound memory (no hibernation)
      },
    };
  }) as MiddlewareHandler<AppEnv>;

  return {
    async publish(site: string, event: DbEvent): Promise<void> {
      rooms.get(site)?.logic.publishDb(event); // no room => no subscribers => no-op
    },
    connect(): Promise<Response> {
      throw new Error('node rooms: upgrade is handled by wsRoute, not connect()');
    },
    wsRoute,
  };
}
