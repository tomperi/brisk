import { describe, expect, it } from 'vitest';
import { RoomLogic, type ConnState, type RoomPort } from '../src/room-logic';
import type { User } from '../src/env';

/** A fake connection: records what it was sent and holds its own state. */
class FakeConn {
  sent: unknown[] = [];
  state: ConnState = { user: { email: '', name: '' }, subs: [], channels: [] };
  /** Parsed view of the last message sent to this conn. */
  last(): Record<string, unknown> {
    return this.sent.at(-1) as Record<string, unknown>;
  }
}

class FakePort implements RoomPort<FakeConn> {
  conns: FakeConn[] = [];
  add(): FakeConn {
    const c = new FakeConn();
    this.conns.push(c);
    return c;
  }
  all(): Iterable<FakeConn> {
    return this.conns;
  }
  send(c: FakeConn, data: string): void {
    c.sent.push(JSON.parse(data));
  }
  getState(c: FakeConn): ConnState {
    return c.state;
  }
  setState(c: FakeConn, s: ConnState): void {
    c.state = s;
  }
}

const user = (email: string): User => ({ email, name: email });
const send = (room: RoomLogic<FakeConn>, c: FakeConn, msg: unknown) =>
  room.handleMessage(c, JSON.stringify(msg));

describe('RoomLogic.hello', () => {
  it('greets with the user and initializes empty state', () => {
    const port = new FakePort();
    const room = new RoomLogic(port);
    const c = port.add();
    room.hello(c, user('a@x'));
    expect(c.last()).toEqual({ t: 'hello', you: { email: 'a@x', name: 'a@x' } });
    expect(c.state).toEqual({ user: { email: 'a@x', name: 'a@x' }, subs: [], channels: [] });
  });
});

describe('RoomLogic db events', () => {
  it('delivers a db event only to subscribers of that collection', () => {
    const port = new FakePort();
    const room = new RoomLogic(port);
    const sub = port.add();
    const other = port.add();
    room.hello(sub, user('s@x'));
    room.hello(other, user('o@x'));
    send(room, sub, { t: 'db:sub', collection: 'posts' });

    room.publishDb({ collection: 'posts', event: 'create', doc: { id: '1' } });

    expect(sub.last()).toEqual({ t: 'db', collection: 'posts', event: 'create', doc: { id: '1' } });
    // `other` only ever got its hello — no db frame.
    expect(other.sent).toHaveLength(1);
  });

  it('stops delivering after db:unsub', () => {
    const port = new FakePort();
    const room = new RoomLogic(port);
    const c = port.add();
    room.hello(c, user('s@x'));
    send(room, c, { t: 'db:sub', collection: 'posts' });
    send(room, c, { t: 'db:unsub', collection: 'posts' });
    room.publishDb({ collection: 'posts', event: 'create', doc: { id: '1' } });
    expect(c.sent).toHaveLength(1); // hello only
  });
});

describe('RoomLogic channels + presence', () => {
  it('broadcasts a channel message to other members, not the sender, carrying from-identity', () => {
    const port = new FakePort();
    const room = new RoomLogic(port);
    const a = port.add();
    const b = port.add();
    room.hello(a, user('a@x'));
    room.hello(b, user('b@x'));
    send(room, a, { t: 'join', channel: 'lobby' });
    send(room, b, { t: 'join', channel: 'lobby' });

    send(room, a, { t: 'send', channel: 'lobby', data: { hi: 1 } });

    expect(b.last()).toEqual({
      t: 'msg',
      channel: 'lobby',
      data: { hi: 1 },
      from: { email: 'a@x', name: 'a@x' },
    });
    // sender excluded: a's last frame is its own presence update from b joining,
    // never the message it sent.
    expect(a.last()).not.toMatchObject({ t: 'msg' });
  });

  it('emits presence with deduped members on join and refreshes on close', () => {
    const port = new FakePort();
    const room = new RoomLogic(port);
    const a = port.add();
    const b = port.add();
    room.hello(a, user('a@x'));
    room.hello(b, user('b@x'));
    send(room, a, { t: 'join', channel: 'lobby' });
    send(room, b, { t: 'join', channel: 'lobby' });

    // After both joined, a saw a presence frame listing both members.
    const presence = a.sent.filter((m) => (m as { t: string }).t === 'presence').at(-1) as {
      members: User[];
    };
    expect(presence.members.map((m) => m.email).sort()).toEqual(['a@x', 'b@x']);

    // a leaves: b gets a presence frame excluding a.
    room.close(a);
    const bPresence = b.sent.filter((m) => (m as { t: string }).t === 'presence').at(-1) as {
      members: User[];
    };
    expect(bPresence.members.map((m) => m.email)).toEqual(['b@x']);
  });

  it('ignores non-JSON frames', () => {
    const port = new FakePort();
    const room = new RoomLogic(port);
    const c = port.add();
    room.hello(c, user('a@x'));
    room.handleMessage(c, 'not json{');
    expect(c.sent).toHaveLength(1); // hello only, no throw
  });
});
