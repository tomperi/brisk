import { DocStore, type Doc } from '../../docs';
import type { User } from '../../env';
import { PLUGIN_COLLECTION_PREFIX, type Plugin, type PluginActionCtx } from '../types';

export const COMMENTS = `${PLUGIN_COLLECTION_PREFIX}comments`;
export const EVENTS = `${PLUGIN_COLLECTION_PREFIX}comments:events`;

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

async function create(ctx: PluginActionCtx, args: Record<string, string>): Promise<Doc> {
  const site = args.site;
  const text = args.text;
  if (!site || !text) throw new Error('site and text are required');
  const by = authorOf(ctx.user);
  const doc = await new DocStore(ctx.platform.db).create(site, COMMENTS, {
    text,
    page: args.page ?? '',
    selector: args.selector ?? '',
    label: args.label ?? '',
    textSnippet: args.textSnippet ?? '',
    html: args.html ?? '',
    parentId: args.parentId ?? '',
    createdBy: by,
    createdByEmail: ctx.user.email,
    resolved: false,
    deleted: false,
  });
  await record(ctx, site, doc.id, args.parentId ? 'reply' : 'create', by);
  ctx.publish(site, { collection: COMMENTS, event: 'create', doc });
  return doc;
}

async function reply(ctx: PluginActionCtx, args: Record<string, string>): Promise<Doc> {
  const { site, id, text } = args;
  if (!site || !id || !text) throw new Error('site, id, and text are required');
  await requireComment(new DocStore(ctx.platform.db), site, id);
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
  await requireComment(store, site, id);
  const doc = (await store.update(site, COMMENTS, id, {
    resolved,
    resolvedBy: resolved ? by : '',
    resolvedAt: resolved ? new Date().toISOString() : '',
  }))!;
  await record(ctx, site, id, resolved ? 'resolve' : 'reopen', by);
  ctx.publish(site, { collection: COMMENTS, event: 'update', doc });
  return doc;
}

async function softDelete(ctx: PluginActionCtx, args: Record<string, string>): Promise<Doc> {
  const { site, id } = args;
  if (!site || !id) throw new Error('site and id are required');
  const by = authorOf(ctx.user);
  const store = new DocStore(ctx.platform.db);
  await requireComment(store, site, id);
  const doc = (await store.update(site, COMMENTS, id, {
    deleted: true,
    deletedBy: by,
    deletedAt: new Date().toISOString(),
  }))!;
  await record(ctx, site, id, 'delete', by);
  ctx.publish(site, { collection: COMMENTS, event: 'update', doc });
  return doc;
}

type Status = 'open' | 'resolved' | 'deleted' | 'all';

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
  const status = (args.status ?? 'open') as Status;
  return (await topLevel(ctx, args.site, status)).map((c) => ({
    id: c.id,
    status: statusOf(c),
    author: String(c.createdBy ?? ''),
    page: String(c.page ?? ''),
    text: String(c.text ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 60),
  }));
}

async function show(ctx: PluginActionCtx, args: Record<string, string>): Promise<string> {
  const { site, id } = args;
  if (!site || !id) throw new Error('site and id are required');
  const store = new DocStore(ctx.platform.db);
  const c = await requireComment(store, site, id);
  const all = await store.list(site, COMMENTS, { limit: 500, sort: 'created' });
  const replies = all.filter((r) => r.parentId === id);
  const head = `[${statusOf(c)}] ${String(c.createdBy)} — ${String(c.text)}\n  page: ${String(c.page)}  selector: ${String(c.selector)}`;
  const body = replies.map((r) => `  ↳ ${String(r.createdBy)}: ${String(r.text)}`).join('\n');
  return replies.length ? `${head}\n${body}` : head;
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
  const status = (args.status ?? 'open') as Status;
  const rows = await topLevel(ctx, args.site, status);
  let out = `# comments on ${args.site}\n`;
  for (const c of rows) {
    out += `\n## [${String(c.id)}] (${statusOf(c)}) ${String(c.text)}\n`;
    out += `- page: \`${String(c.page)}\`\n`;
    if (c.selector) out += `- selector: \`${String(c.selector)}\`\n`;
    if (c.textSnippet) out += `- text: "${String(c.textSnippet)}"\n`;
    out += `- by: ${String(c.createdBy)}\n`;
  }
  return out;
}

const siteArg = { name: 'site', required: true, help: 'target site' } as const;
const idArg = { name: 'id', required: true, help: 'comment id' } as const;

export const comments: Plugin = {
  id: 'comments',
  name: 'Comments',
  description: 'Leave feedback on any element; drafts stay local until you publish.',
  requirement: 'default',
  widget: 'widget.js',
  actions: {
    create: {
      summary: 'create a comment',
      args: [
        siteArg,
        { name: 'text', required: true },
        { name: 'page' },
        { name: 'selector' },
        { name: 'label' },
        { name: 'textSnippet' },
        { name: 'html' },
      ],
      render: 'json',
      handler: create,
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
