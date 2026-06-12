# Realtime wire protocol

JSON messages over one websocket per page, `GET /api/ws` (query `?site=` in
path mode). The worker routes the upgrade to the site's `SiteRoom` Durable
Object with the authenticated user attached as the `x-brisk-user` header.

Producers/consumers: `worker/src/room.ts` (server) and `sdk/src/brisk.ts`
(client). Change one, change both — there is no schema enforcement beyond
these two files agreeing.

## Client → server

| Message                         | Meaning                                        |
| ------------------------------- | ---------------------------------------------- |
| `{ t: 'db:sub', collection }`   | Start receiving change events for a collection |
| `{ t: 'db:unsub', collection }` | Stop                                           |
| `{ t: 'join', channel }`        | Join a channel (triggers a presence broadcast) |
| `{ t: 'leave', channel }`       | Leave (triggers a presence broadcast)          |
| `{ t: 'send', channel, data }`  | Broadcast `data` to the channel                |

## Server → client

| Message                                     | Meaning                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `{ t: 'hello', you }`                       | Sent once on connect; `you` is the authenticated user                        |
| `{ t: 'db', collection, event, doc?, id? }` | `event` ∈ `create / update / delete`; `doc` on create/update, `id` on delete |
| `{ t: 'msg', channel, data, from }`         | A `send` from someone else; `from` is `{ email, name, picture? }`            |
| `{ t: 'presence', channel, members }`       | Full member list, sent to everyone on each join/leave                        |

## Semantics

- **`send` excludes the sender** — you don't hear your own messages.
  Db events do _not_ exclude anyone: the creator's own `subscribe` fires too
  (UIs render from the event, not from the request response).
- **Presence dedupes by email**: two tabs from one person are one member.
- **State lives in socket attachments** (subs + channels survive Durable
  Object hibernation); nothing is persisted. On reconnect the _client_
  replays its subscriptions and joins — the server remembers nothing about
  dead sockets.
- Db events originate in `app.ts` route handlers, which POST to the room's
  `/publish` endpoint via `waitUntil` after each mutation.
