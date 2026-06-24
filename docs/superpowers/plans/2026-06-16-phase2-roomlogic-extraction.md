# Phase 2: RoomLogic Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the realtime fan-out logic out of the `SiteRoom` Durable Object into a platform-neutral `RoomLogic<C>` class, leaving the DO as a thin transport shell — so a Node websocket server can drive the same brain in Phase 3 — without changing any observable realtime behavior.

**Architecture:** Today `room.ts` mixes Durable Object plumbing (`WebSocketPair`, `acceptWebSocket`, `serializeAttachment`/`deserializeAttachment`, `getWebSockets`, the DO lifecycle methods) with fan-out logic (db-event broadcast, channel messages, presence). We introduce `RoomLogic<C>` operating over a transport-neutral `RoomPort<C>` interface. The DO implements `RoomPort<WebSocket>` (hibernation lives here) and delegates its lifecycle to a `RoomLogic` instance. Because `RoomLogic` is pure, it gains fast unit tests that the integration suite couldn't easily provide (presence, multi-connection exclusions).

**Tech Stack:** TypeScript (strict, extensionless worker imports), Cloudflare Durable Objects (websocket hibernation), Hono, vitest + `@cloudflare/vitest-pool-workers`.

**Prerequisite:** Phase 1 complete (`platform/types.ts` exists with `DbEvent`; `room.ts` already imports `DbEvent` from there) **and** gate-hardening complete (the worker suite now includes a websocket realtime round-trip integration test — that test is this phase's behavioral safety net and MUST stay green).

---

## Scope notes & deliberate decisions

- **`room-logic.ts` lives at `worker/src/room-logic.ts`** (sibling of `room.ts`), not under `platform/`. It is platform-neutral but the `core/` vs `platform/` directory move is deferred to Phase 3 (consistent with Phase 1). The neutrality is enforced by content, not folder: `room-logic.ts` imports only `type`s (`User`, `DbEvent`) and touches no Cloudflare/Node API.
- **`room.ts` stays the DO** and stays exported from `index.cf.ts` (wrangler binds `SiteRoom`). Only its internals change.
- **The wire protocol is frozen** ([docs/realtime-protocol.md](../../realtime-protocol.md)). Message shapes (`hello`, `db`, `msg`, `presence`) and client frames (`db:sub`/`db:unsub`/`join`/`leave`/`send`) are reproduced verbatim — the SDK must not need a single change.
- **Behavior must be byte-identical.** The extraction is a move, not a redesign: same subscription/presence semantics, same `from`/`you` identity, same sender-exclusion on `send`, same presence-on-join/leave/close.

---

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `worker/src/room-logic.ts` | `RoomPort<C>`, `ConnState`, `RoomLogic<C>` — platform-neutral fan-out | Create |
| `worker/src/room.ts` | `SiteRoom` DO: hibernation transport shell implementing `RoomPort<WebSocket>`, delegating to `RoomLogic` | Rewrite |
| `worker/test/room-logic.test.ts` | Pure unit tests for `RoomLogic` via a fake in-memory port | Create |

---

## Task 0: Baseline — confirm the suite (incl. the websocket test) is green

**Files:** none

- [ ] **Step 1: Run the full suite + typecheck**

Run: `cd worker && pnpm test && pnpm typecheck` (use `run_in_background: true` per the tooling hook)
Expected: all tests PASS (the Phase 1 33 + the gate-hardening additions, including the websocket realtime round-trip and content-type tests), typecheck clean. If red, stop — Phase 2 assumes green.

---

## Task 1: Create the platform-neutral `RoomLogic`

**Files:**
- Create: `worker/src/room-logic.ts`

- [ ] **Step 1: Write `room-logic.ts`**

```ts
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
```

This is a verbatim move of the logic in the current `room.ts`: `hello` ← the `fetch` upgrade tail (`setAttachment` + `send({t:'hello'})`), `handleMessage` ← `webSocketMessage` (minus the `typeof raw !== 'string'` guard, which stays in the shell), `close` ← `webSocketClose`, `publishDb` ← `broadcastDb`, and `broadcastToChannel`/`broadcastPresence` unchanged except routing socket access through `this.port`.

- [ ] **Step 2: Typecheck**

Run: `cd worker && pnpm typecheck` (`run_in_background: true`)
Expected: clean. `room-logic.ts` must NOT import `cloudflare:workers` or reference `WebSocket`/`WebSocketPair` — only the `User`/`DbEvent` types.

- [ ] **Step 3: Commit**

```bash
git add worker/src/room-logic.ts
git commit -m "feat(worker): extract platform-neutral RoomLogic"
```

---

## Task 2: Rewrite `SiteRoom` as a thin transport shell

**Files:**
- Modify: `worker/src/room.ts` (full replacement)

- [ ] **Step 1: Replace the entire contents of `worker/src/room.ts`**

```ts
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
```

Notes for the implementer:
- The `new RoomLogic<WebSocket>(this)` field initializer runs after the implicit `super()`, so `this` is valid; `RoomLogic` only stores the reference and uses it later (at message/publish time).
- The `ConnState` shape is identical to the old private `Attachment` interface (`{ user, subs, channels }`); the old `Attachment` interface and the `getAttachment`/`setAttachment` free functions are deleted (their bodies now live in `getState`/`setState`).
- `DbEvent` is no longer declared here (Phase 1 already moved it to `platform/types`); keep importing it.

- [ ] **Step 2: Typecheck**

Run: `cd worker && pnpm typecheck` (`run_in_background: true`)
Expected: clean. If `implements RoomPort<WebSocket>` errors, the four port methods’ signatures must exactly match `RoomPort` (all/send/getState/setState).

- [ ] **Step 3: Run the full integration suite — the behavioral gate**

Run: `cd worker && pnpm test` (`run_in_background: true`)
Expected: ALL tests PASS, including the websocket realtime round-trip test from gate-hardening. That test exercises connect → `db:sub` → db POST → receive `{t:'db',...}` and the `hello` identity, so a green run is strong proof the DO shell still behaves identically. If realtime tests fail, the most likely cause is a missed delegation (e.g. forgetting `this.room.hello(server, user)` after `acceptWebSocket`).

- [ ] **Step 4: Commit**

```bash
git add worker/src/room.ts
git commit -m "refactor(worker): SiteRoom delegates to RoomLogic (thin DO shell)"
```

---

## Task 3: Unit-test `RoomLogic` in isolation

**Files:**
- Create: `worker/test/room-logic.test.ts`

Now that the logic is pure, test presence/exclusion/subscription semantics directly with a fake port — no workers pool, no websockets, fast and exhaustive.

- [ ] **Step 1: Write `worker/test/room-logic.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the new unit tests**

Run: `cd worker && pnpm test` (`run_in_background: true`)
Expected: all tests pass, including the new `room-logic.test.ts` suite. These run as plain pure tests (no `cloudflare:workers` import in `room-logic.ts`, so they load cleanly in the pool).

- [ ] **Step 3: Format + commit**

```bash
cd .. && pnpm format
git add worker/test/room-logic.test.ts
git commit -m "test(worker): unit-test RoomLogic fan-out, channels, presence"
```

---

## Task 4: Verify the extraction held

**Files:** none (verification only)

- [ ] **Step 1: Confirm `room-logic.ts` is genuinely platform-neutral**

Run: `cd worker && rg -n "cloudflare:workers|WebSocketPair|acceptWebSocket|serializeAttachment|deserializeAttachment|getWebSockets|DurableObject" src/room-logic.ts`
Expected: NO matches. All Cloudflare/hibernation APIs must remain in `room.ts` only.

Run: `cd worker && rg -n "WebSocketPair|acceptWebSocket|serializeAttachment|deserializeAttachment|getWebSockets" src/room.ts`
Expected: matches present (the shell legitimately owns these).

- [ ] **Step 2: Full green gate**

Run: `cd worker && pnpm test && pnpm typecheck` (`run_in_background: true`)
Expected: everything green — the Phase 1 suite, the gate-hardening websocket/content-type tests, and the new `RoomLogic` unit tests. This is the proof Phase 2 preserved realtime behavior end-to-end while making the brain transport-neutral.

---

## What Phase 2 sets up for Phase 3

`RoomLogic<C>` is now ready for a second `RoomPort` implementation: the Node in-process server will implement `RoomPort<NodeConn>` over a `Map<site, Set<NodeConn>>` (state held in memory on each `NodeConn`, no serialize/deserialize), driving the exact same `RoomLogic`. The `FakePort` in `room-logic.test.ts` is essentially a preview of that in-process port.

---

## Self-review

- **Spec coverage:** Implements the design's "extract `RoomLogic`, DO becomes a thin shell" — the one non-mechanical refactor flagged in the design. `RoomPort<C>` is the transport seam; the DO implements it; Node's impl is explicitly deferred to Phase 3.
- **Placeholder scan:** No TBDs; full file contents for `room-logic.ts`, `room.ts`, and the unit test are given.
- **Type consistency:** `RoomPort<C>` (`all`/`send`/`getState`/`setState`) is defined in Task 1, implemented by `SiteRoom` in Task 2, and by `FakePort` in Task 3 — identical signatures. `ConnState` (`{ user, subs, channels }`) is the same shape the DO previously called `Attachment`. `RoomLogic`'s public surface (`hello`/`handleMessage`/`close`/`publishDb`) is exactly what the shell calls in Task 2 and the tests call in Task 3. The frozen protocol frames (`hello`/`db`/`msg`/`presence`) match the originals in `room.ts`.
