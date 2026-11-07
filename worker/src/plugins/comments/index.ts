import { DocStore, type Doc } from '../../docs';
import type { User } from '../../env';
import { PLUGIN_COLLECTION_PREFIX, type Plugin, type PluginActionCtx } from '../types';
import { ANCHOR_ARGS, anchorFields, anchorLines, parseAnchor } from './anchor';
import { seenDocId } from './inbox';
import {
  buildThreads,
  parseEmoji,
  reactionsText,
  REACTIONS,
  threadMarkdown,
  type Emoji,
  type Thread,
} from './threads';

export const COMMENTS = `${PLUGIN_COLLECTION_PREFIX}comments`;
export const EVENTS = `${PLUGIN_COLLECTION_PREFIX}comments:events`;
export const SEEN = `${PLUGIN_COLLECTION_PREFIX}comments:seen`;

/** Display identity for attribution — mirrors how deploys attribute an owner. */
const authorOf = (user: User): string => user.name || user.email;

/** Append an audit event. Best-effort: the mutation it records has already
 *  committed, so a failed event write must not fail the action (that would
 *  report a false error and make a retry duplicate the mutation). The trail
 *  stays append-only — it just misses this entry on a rare write failure. */
async function record(
  ctx: PluginActionCtx,
  site: string,
  commentId: string,
  action: string,
  by: string,
): Promise<void> {
  try {
    await new DocStore(ctx.platform.db).create(site, EVENTS, { commentId, action, by });
  } catch (err) {
    console.warn(`[comments] audit write failed (${action} ${site}/${commentId}):`, err);
  }
}

async function requireComment(store: DocStore, site: string, id: string): Promise<Doc> {
  const doc = await store.get(site, COMMENTS, id);
  if (!doc) throw new Error(`no comment ${id} on ${site}`);
  return doc;
}

function reactionArg(raw: string | undefined): Emoji | null {
  if (!raw) return null;
  const emoji = parseEmoji(raw);
  if (!emoji) throw new Error(`unknown reaction: ${raw} (${REACTIONS.join(' ')})`);
  return emoji;
}

/** The comment or reply a reaction under `parentId` lands on: the thread head
 *  by default, else one of its live replies. */
async function reactionTarget(
  store: DocStore,
  site: string,
  parentId: string,
  reactTo: string | undefined,
): Promise<string> {
  const thread = await requireComment(store, site, parentId);
  if (thread.parentId)
    throw new Error(`${parentId} is a reply — use its thread ${String(thread.parentId)}`);
  if (thread.deleted) throw new Error(`comment ${parentId} is deleted`);
  const to = reactTo || parentId;
  if (to === parentId) return to;
  const target = await requireComment(store, site, to);
  if (target.parentId !== parentId || target.reaction)
    throw new Error(`${to} is not a comment in thread ${parentId}`);
  if (target.deleted) throw new Error(`comment ${to} is deleted`);
  return to;
}

/** One record per person, emoji and target: its id is derived from them, so a
 *  repeat collides on the key and a removed reaction comes back instead. */
async function reactionId(reactTo: string, emoji: Emoji, email: string): Promise<string> {
  const key = new TextEncoder().encode(`${reactTo}\n${emoji}\n${email.trim().toLowerCase()}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
  return `rx-${[...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function create(ctx: PluginActionCtx, args: Record<string, string>): Promise<Doc> {
  const site = args.site;
  const text = args.text ?? '';
  const reaction = reactionArg(args.reaction);
  if (!site) throw new Error('site is required');
  if (reaction && text) throw new Error('a reaction has no text');
  if (!reaction && !text) throw new Error('site and text are required');
  if (args.reactTo && !(reaction && args.parentId))
    throw new Error('reactTo needs a reaction and a parentId');
  const anchor = parseAnchor(args);
  const store = new DocStore(ctx.platform.db);
  const reactTo =
    reaction && args.parentId ? await reactionTarget(store, site, args.parentId, args.reactTo) : '';
  const by = authorOf(ctx.user);
  const fields = {
    text,
    page: args.page ?? '',
    ...anchorFields(anchor),
    label: args.label ?? '',
    textSnippet: args.textSnippet ?? '',
    html: args.html ?? '',
    parentId: args.parentId ?? '',
    ...(reaction ? { reaction } : {}),
    ...(reactTo ? { reactTo } : {}),
    createdBy: by,
    createdByEmail: ctx.user.email,
    resolved: false,
    deleted: false,
  };
  if (reaction && reactTo) {
    return addReaction(
      ctx,
      store,
      site,
      await reactionId(reactTo, reaction, ctx.user.email),
      fields,
    );
  }
  const doc = await store.create(site, COMMENTS, fields);
  await record(ctx, site, doc.id, reaction ? 'react' : args.parentId ? 'reply' : 'create', by);
  ctx.publish(site, { collection: COMMENTS, event: 'create', doc });
  return doc;
}

/** Adding a reaction I already left is a no-op; adding one I removed revives it. */
async function addReaction(
  ctx: PluginActionCtx,
  store: DocStore,
  site: string,
  id: string,
  fields: Record<string, unknown>,
): Promise<Doc> {
  const by = String(fields.createdBy);
  const made = await store.create(site, COMMENTS, fields, { id }).catch(async (err: unknown) => {
    if (await store.get(site, COMMENTS, id)) return null;
    throw err;
  });
  if (made) {
    await record(ctx, site, id, 'react', by);
    ctx.publish(site, { collection: COMMENTS, event: 'create', doc: made });
    return made;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await requireComment(store, site, id);
    if (!existing.deleted) return existing;
    const doc = await store.update(
      site,
      COMMENTS,
      id,
      { deleted: false, deletedBy: '', deletedAt: '' },
      { ifUpdatedAt: existing.updatedAt },
    );
    if (doc) {
      await record(ctx, site, id, 'react', by);
      ctx.publish(site, { collection: COMMENTS, event: 'update', doc });
      return doc;
    }
  }
  throw new Error(`reaction ${id} is changing concurrently — retry`);
}

async function react(ctx: PluginActionCtx, args: Record<string, string>): Promise<Doc> {
  const { site, id, emoji } = args;
  if (!site || !id || !emoji) throw new Error('site, id, and emoji are required');
  const target = await requireComment(new DocStore(ctx.platform.db), site, id);
  return create(ctx, {
    site,
    text: '',
    reaction: emoji,
    page: String(target.page ?? ''),
    parentId: String(target.parentId || target.id),
    reactTo: id,
  });
}

async function reply(ctx: PluginActionCtx, args: Record<string, string>): Promise<Doc> {
  const { site, id, text } = args;
  if (!site || !id || !text) throw new Error('site, id, and text are required');
  const target = await requireComment(new DocStore(ctx.platform.db), site, id);
  // Threads are one level deep — the widget and lists only show a comment's
  // direct children, so a reply-to-a-reply would be invisible everywhere.
  if (target.parentId) {
    throw new Error(`${id} is itself a reply — reply to its thread ${String(target.parentId)}`);
  }
  return create(ctx, { site, text, page: args.page ?? '', parentId: id });
}

async function setResolved(
  ctx: PluginActionCtx,
  args: Record<string, string>,
  resolved: boolean,
): Promise<Doc> {
  const { site, id } = args;
  if (!site || !id) throw new Error('site and id are required');
  const by = authorOf(ctx.user);
  const store = new DocStore(ctx.platform.db);
  // Deleted comments are frozen. The check alone leaves a window where a
  // racing delete lands between our read and write and gets overwritten by
  // this merge (resurrecting the comment) — the CAS on the read snapshot
  // closes it: a concurrent write voids our attempt and we re-read.
  let doc: Doc | null = null;
  for (let attempt = 0; attempt < 2 && !doc; attempt++) {
    const existing = await requireComment(store, site, id);
    if (existing.deleted) throw new Error(`comment ${id} is deleted`);
    doc = await store.update(
      site,
      COMMENTS,
      id,
      {
        resolved,
        resolvedBy: resolved ? by : '',
        resolvedAt: resolved ? new Date().toISOString() : '',
      },
      { ifUpdatedAt: String(existing.updatedAt) },
    );
  }
  if (!doc) throw new Error(`comment ${id} is changing concurrently — retry`);
  await record(ctx, site, id, resolved ? 'resolve' : 'reopen', by);
  ctx.publish(site, { collection: COMMENTS, event: 'update', doc });
  return doc;
}

async function softDelete(ctx: PluginActionCtx, args: Record<string, string>): Promise<Doc> {
  const { site, id } = args;
  if (!site || !id) throw new Error('site and id are required');
  const by = authorOf(ctx.user);
  const store = new DocStore(ctx.platform.db);
  // Same CAS discipline as setResolved; deleting an already-deleted comment is
  // an idempotent no-op (no re-stamp, no duplicate audit event).
  let doc: Doc | null = null;
  for (let attempt = 0; attempt < 2 && !doc; attempt++) {
    const existing = await requireComment(store, site, id);
    if (existing.deleted) return existing;
    doc = await store.update(
      site,
      COMMENTS,
      id,
      {
        deleted: true,
        deletedBy: by,
        deletedAt: new Date().toISOString(),
      },
      { ifUpdatedAt: String(existing.updatedAt) },
    );
  }
  if (!doc) throw new Error(`comment ${id} is changing concurrently — retry`);
  await record(ctx, site, id, 'delete', by);
  ctx.publish(site, { collection: COMMENTS, event: 'update', doc });
  return doc;
}

/** Sets the caller's seen stamp on one thread: a timestamp, or '' for an
 *  explicit unread. The doc lives under a fixed per-person id, so racing first
 *  writes collide on the key instead of forking two docs; a lost create or CAS
 *  re-reads. */
async function writeSeen(
  ctx: PluginActionCtx,
  args: Record<string, string>,
  stamp: string,
): Promise<Doc> {
  const { site, id } = args;
  if (!site || !id) throw new Error('site and id are required');
  const store = new DocStore(ctx.platform.db);
  const target = await requireComment(store, site, id);
  if (target.parentId) {
    throw new Error(`${id} is a reply — use its thread ${String(target.parentId)}`);
  }
  const user = seenDocId(ctx.user.email);
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await store.get(site, SEEN, user);
    const seen = { ...(existing?.seen as Record<string, string> | undefined) };
    if (existing && seen[id] === stamp) return existing;
    seen[id] = stamp;

    const doc = existing
      ? await store.update(site, SEEN, user, { seen }, { ifUpdatedAt: existing.updatedAt })
      : await store.create(site, SEEN, { user, seen }, { id: user }).catch(async (err: unknown) => {
          if (await store.get(site, SEEN, user)) return null;
          throw err;
        });
    if (doc) {
      ctx.publish(site, { collection: SEEN, event: existing ? 'update' : 'create', doc });
      return doc;
    }
  }
  throw new Error(`seen state for ${id} is changing concurrently — retry`);
}

type Status = 'open' | 'resolved' | 'deleted' | 'all';
const STATUSES = new Set<string>(['open', 'resolved', 'deleted', 'all']);

/** A typo'd status must error, not silently filter every comment out. */
function statusArg(raw: string | undefined): Status {
  const status = raw ?? 'open';
  if (!STATUSES.has(status))
    throw new Error(`unknown status: ${status} (open|resolved|deleted|all)`);
  return status as Status;
}

const statusOf = (c: Doc): Exclude<Status, 'all'> =>
  c.deleted ? 'deleted' : c.resolved ? 'resolved' : 'open';

async function topLevel(ctx: PluginActionCtx, site: string, status: Status): Promise<Doc[]> {
  const docs = await new DocStore(ctx.platform.db).list(site, COMMENTS, {
    limit: 500,
    sort: '-created',
  });
  return docs.filter((c) => !c.parentId && (status === 'all' || statusOf(c) === status));
}

async function list(ctx: PluginActionCtx, args: Record<string, string>): Promise<unknown> {
  if (!args.site) throw new Error('site is required');
  const status = statusArg(args.status);
  return (await topLevel(ctx, args.site, status)).map((c) => ({
    id: c.id,
    status: statusOf(c),
    author: String(c.createdBy ?? ''),
    page: String(c.page ?? ''),
    text: c.reaction
      ? `${String(c.reaction)} reaction`
      : String(c.text ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 60),
  }));
}

/** Every thread in the newest 500 records, newest first, numbered as the widget numbers them. */
async function siteThreads(store: DocStore, site: string): Promise<Thread[]> {
  const docs = await store.list(site, COMMENTS, { limit: 500, sort: '-created' });
  return buildThreads({ drafts: [], docs, seen: {}, me: '' });
}

async function show(ctx: PluginActionCtx, args: Record<string, string>): Promise<string> {
  const { site, id } = args;
  if (!site || !id) throw new Error('site and id are required');
  const store = new DocStore(ctx.platform.db);
  const c = await requireComment(store, site, id);
  const threadId = String(c.parentId || c.id);
  const t = (await siteThreads(store, site)).find((x) => x.id === threadId);
  if (!t)
    throw new Error(`thread ${threadId} is past the newest 500 records — open it in the widget`);
  const said = t.reaction ? `reacted ${t.reaction}` : `— ${t.text}`;
  const lines = [
    `[${t.status}] #${t.num} ${t.author} ${said}`,
    `  page: ${t.page}`,
    ...anchorLines(t.anchor).map((l) => `  ${l}`),
  ];
  if (t.reactions.length) lines.push(`  reactions: ${reactionsText(t.reactions)}`);
  for (const r of t.replies) {
    lines.push(`  ↳ ${r.author}: ${r.text}`);
    if (r.reactions.length) lines.push(`    reactions: ${reactionsText(r.reactions)}`);
  }
  return lines.join('\n');
}

async function history(ctx: PluginActionCtx, args: Record<string, string>): Promise<unknown> {
  const { site, id } = args;
  if (!site || !id) throw new Error('site and id are required');
  const events = await new DocStore(ctx.platform.db).list(site, EVENTS, {
    limit: 500,
    sort: 'created',
  });
  return events
    .filter((e) => e.commentId === id)
    .map((e) => ({ action: String(e.action), by: String(e.by), at: e.createdAt }));
}

async function exportMd(ctx: PluginActionCtx, args: Record<string, string>): Promise<string> {
  if (!args.site) throw new Error('site is required');
  const status = statusArg(args.status);
  const threads = await siteThreads(new DocStore(ctx.platform.db), args.site);
  let out = `# comments on ${args.site}\n`;
  for (const t of threads)
    if (status === 'all' || t.status === status) out += `\n${threadMarkdown(t)}\n`;
  return out;
}

const siteArg = { name: 'site', required: true, help: 'target site' } as const;
const idArg = { name: 'id', required: true, help: 'comment id' } as const;

export const comments: Plugin = {
  id: 'comments',
  name: 'Comments',
  description: 'Leave feedback on any element; drafts stay local until you publish.',
  requirement: 'default',
  widget: true,
  actions: {
    create: {
      summary: 'create a comment',
      args: [
        siteArg,
        { name: 'text', help: 'required unless reaction is set' },
        { name: 'page' },
        { name: 'selector' },
        { name: 'label' },
        { name: 'textSnippet' },
        { name: 'html' },
        ...ANCHOR_ARGS.map((name) => ({ name })),
        {
          name: 'reaction',
          help: `an emoji left on the page instead of text: ${REACTIONS.join(' ')}`,
        },
      ],
      render: 'json',
      handler: create,
    },
    react: {
      summary: 'react to a comment or reply with an emoji (delete the reaction to remove it)',
      args: [siteArg, idArg, { name: 'emoji', required: true, help: REACTIONS.join(' ') }],
      render: 'json',
      handler: react,
    },
    reply: {
      summary: 'reply to a comment',
      args: [siteArg, idArg, { name: 'text', required: true }],
      render: 'json',
      handler: reply,
    },
    resolve: {
      summary: 'resolve a comment',
      args: [siteArg, idArg],
      render: 'text',
      handler: (ctx, args) => setResolved(ctx, args, true).then((d) => `resolved ${d.id}`),
    },
    reopen: {
      summary: 'reopen a comment',
      args: [siteArg, idArg],
      render: 'text',
      handler: (ctx, args) => setResolved(ctx, args, false).then((d) => `reopened ${d.id}`),
    },
    delete: {
      summary: 'delete a comment (soft)',
      args: [siteArg, idArg],
      render: 'json',
      handler: softDelete,
    },
    seen: {
      summary: 'mark a comment read for you',
      args: [siteArg, idArg],
      render: 'json',
      handler: (ctx, args) => writeSeen(ctx, args, new Date().toISOString()),
    },
    unseen: {
      summary: 'mark a comment unread for you',
      args: [siteArg, idArg],
      render: 'json',
      handler: (ctx, args) => writeSeen(ctx, args, ''),
    },
    list: {
      summary: "list a site's comments",
      args: [siteArg, { name: 'status', help: 'open|resolved|deleted|all (default open)' }],
      render: 'table',
      columns: ['id', 'status', 'author', 'page', 'text'],
      handler: list,
    },
    show: {
      summary: 'show a comment and its replies',
      args: [siteArg, idArg],
      render: 'text',
      handler: show,
    },
    history: {
      summary: 'audit history for a comment',
      args: [siteArg, idArg],
      render: 'table',
      columns: ['action', 'by', 'at'],
      handler: history,
    },
    export: {
      summary: 'export comments as markdown for an agent',
      args: [siteArg, { name: 'status', help: 'open|resolved|deleted|all (default open)' }],
      render: 'markdown',
      handler: exportMd,
    },
  },
};
