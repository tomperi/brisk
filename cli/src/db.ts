import fsp from 'node:fs/promises';
import { ApiError, request, resolveConnection, type Connection } from './config.js';
import { resolveSite, type Flags } from './commands.js';
import { bold, dim, green, yellow } from './ui.js';

export interface DbFlags extends Flags {
  file?: string;
  jsonl?: string;
  limit?: string;
  sort?: string;
  json?: boolean;
  timeout?: string;
}

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = Math.floor((2 ** 31 - 1) / 1000);
const BATCH_CONCURRENCY = 4;
const SERVER_LIST_DEFAULT = 100;
const SERVER_LIST_MAX = 500;

const USAGE = `usage:
  brisk db get <collection> <id>
  brisk db list <collection> [--limit n] [--sort -created]
  brisk db put <collection> <id> [--file <path>]   (JSON object; stdin without --file)
  brisk db put <collection> --jsonl <path>         (one {"id":…,"doc":{…}} per line)
  brisk db delete <collection> <id>`;

interface Ctx {
  conn: Connection;
  site: string;
  timeoutMs: number;
  json: boolean;
}

/** One row of `put`, single or batch. `line` is set for --jsonl rows. */
interface PutResult {
  line?: number;
  id: string | null;
  ok: boolean;
  status?: number;
  error?: string;
}

interface Doc {
  id: string;
  createdAt: string;
  updatedAt: string;
  [field: string]: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const docPath = (collection: string, id?: string): string =>
  `/api/db/${encodeURIComponent(collection)}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;

function context(flags: DbFlags): Ctx {
  const dir = process.cwd();
  const seconds = flags.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(flags.timeout);
  // AbortSignal.timeout fires after 1 ms for any delay past 2^31-1 ms.
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_TIMEOUT_S) {
    throw new Error(
      `--timeout must be between 0 and ${MAX_TIMEOUT_S} seconds, got "${flags.timeout}"`,
    );
  }
  const site = resolveSite(dir, flags);
  // An empty x-brisk-site falls back to the host's site (the dashboard's `home`).
  if (!site) throw new Error('--site is empty');
  return {
    conn: resolveConnection(flags, dir),
    site,
    timeoutMs: seconds * 1000,
    json: Boolean(flags.json),
  };
}

/** Every db call names its site: the server picks the db namespace from x-brisk-site. */
async function call<T>(
  ctx: Ctx,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  try {
    return await request<T>(ctx.conn, route, {
      method,
      headers: {
        'x-brisk-site': ctx.site,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') {
      throw new Error(`${method} ${route} timed out after ${ctx.timeoutMs / 1000}s`);
    }
    // fetch reports every network failure as "fetch failed"; the reason is the cause.
    const cause = (err as Error).cause as { code?: string; message?: string } | undefined;
    if (cause) throw new Error(`${method} ${route} failed: ${cause.code ?? cause.message}`);
    throw err;
  }
}

export async function db(args: string[], flags: DbFlags): Promise<void> {
  const [sub, collection, id, ...extra] = args;
  if (!sub || !collection || extra.length) throw new Error(USAGE);
  const ctx = context(flags);
  switch (sub) {
    case 'get':
      if (!id) throw new Error(USAGE);
      return get(ctx, collection, id);
    case 'list':
    case 'ls':
      if (id) throw new Error(USAGE);
      return list(ctx, collection, flags);
    case 'put':
      if (flags.jsonl) {
        if (id || flags.file) throw new Error(`--jsonl takes no <id> or --file\n${USAGE}`);
        return putBatch(ctx, collection, flags.jsonl);
      }
      if (!id) throw new Error(USAGE);
      return putOne(ctx, collection, id, flags.file);
    case 'delete':
    case 'rm':
      if (!id) throw new Error(USAGE);
      return remove(ctx, collection, id);
    default:
      throw new Error(`unknown db command: ${sub}\n${USAGE}`);
  }
}

async function get(ctx: Ctx, collection: string, id: string): Promise<void> {
  const { body } = await call<Doc>(ctx, 'GET', docPath(collection, id));
  console.log(ctx.json ? JSON.stringify(body) : JSON.stringify(body, null, 2));
}

async function list(ctx: Ctx, collection: string, flags: DbFlags): Promise<void> {
  const params = new URLSearchParams();
  if (flags.limit !== undefined) {
    const n = Number(flags.limit);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`--limit must be a positive integer, got "${flags.limit}"`);
    }
    params.set('limit', String(n));
  }
  if (flags.sort !== undefined) {
    if (flags.sort !== 'created' && flags.sort !== '-created') {
      throw new Error(`--sort must be "created" or "-created", got "${flags.sort}"`);
    }
    params.set('sort', flags.sort);
  }
  const query = params.size ? `?${params}` : '';
  const { body } = await call<{ docs: Doc[] }>(ctx, 'GET', `${docPath(collection)}${query}`);
  if (ctx.json) {
    console.log(JSON.stringify(body));
    return;
  }
  if (!body.docs.length) {
    console.log(dim('(none)'));
    return;
  }
  const width = Math.max(...body.docs.map((d) => d.id.length)) + 2;
  for (const d of body.docs) console.log(`${bold(d.id.padEnd(width))}${dim(d.updatedAt)}`);
  const asked = flags.limit === undefined ? SERVER_LIST_DEFAULT : Number(flags.limit);
  if (body.docs.length >= Math.min(asked, SERVER_LIST_MAX)) {
    console.error(
      dim(
        `showing ${body.docs.length}; there may be more (--limit, up to ${SERVER_LIST_MAX}, --sort -created)`,
      ),
    );
  }
}

async function remove(ctx: Ctx, collection: string, id: string): Promise<void> {
  await call(ctx, 'DELETE', docPath(collection, id));
  console.log(
    ctx.json
      ? JSON.stringify({ id, ok: true })
      : `${green('✓')} deleted ${bold(`${collection}/${id}`)} ${dim(`on ${ctx.site}`)}`,
  );
}

/** Never throws: a failed row is reported in its result so a batch keeps going. */
async function putRow(
  ctx: Ctx,
  collection: string,
  id: string,
  doc: Record<string, unknown>,
): Promise<PutResult> {
  try {
    const { status } = await call(ctx, 'PUT', docPath(collection, id), doc);
    return { id, ok: true, status };
  } catch (err) {
    const status = err instanceof ApiError ? err.status : undefined;
    return { id, ok: false, ...(status ? { status } : {}), error: (err as Error).message };
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error(`put needs --file <path> or JSON on stdin\n${USAGE}`);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function putOne(
  ctx: Ctx,
  collection: string,
  id: string,
  file: string | undefined,
): Promise<void> {
  const text = file && file !== '-' ? await fsp.readFile(file, 'utf8') : await readStdin();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`${file && file !== '-' ? file : 'stdin'} is not valid JSON`);
  }
  if (!isObject(doc)) throw new Error('the doc must be a JSON object');
  const result = await putRow(ctx, collection, id, doc);
  report(ctx, collection, [result]);
  if (ctx.json) console.log(JSON.stringify(result));
}

/** Parses one --jsonl line into a row to send, or the failure to report for it. */
function parseLine(
  text: string,
  line: number,
): { id: string; doc: Record<string, unknown> } | PutResult {
  let entry: unknown;
  try {
    entry = JSON.parse(text);
  } catch {
    return { line, id: null, ok: false, error: 'invalid JSON' };
  }
  const id = isObject(entry) && typeof entry.id === 'string' ? entry.id : null;
  if (!id) return { line, id: null, ok: false, error: 'missing string "id"' };
  if (!isObject((entry as { doc?: unknown }).doc)) {
    return { line, id, ok: false, error: '"doc" must be a JSON object' };
  }
  return { id, doc: (entry as { doc: Record<string, unknown> }).doc };
}

async function putBatch(ctx: Ctx, collection: string, file: string): Promise<void> {
  const lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
  const rows = lines
    .map((text, i) => ({ text: text.trim(), line: i + 1 }))
    .filter((r) => r.text)
    .map((r) => ({ line: r.line, parsed: parseLine(r.text, r.line) }));

  const results: PutResult[] = new Array(rows.length);
  // Rows that share an id run in line order on one worker, so the last line wins.
  const byId = new Map<string, number[]>();
  rows.forEach(({ parsed }, i) => {
    if ('ok' in parsed) results[i] = parsed;
    else byId.set(parsed.id, [...(byId.get(parsed.id) ?? []), i]);
  });
  const queue = [...byId.values()];
  const worker = async (): Promise<void> => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      for (const i of group) {
        const { line, parsed } = rows[i]!;
        if ('ok' in parsed) continue;
        results[i] = { line, ...(await putRow(ctx, collection, parsed.id, parsed.doc)) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, worker));

  report(ctx, collection, results);
  const failed = results.filter((r) => !r.ok).length;
  if (ctx.json) {
    console.log(JSON.stringify({ ok: failed === 0, total: results.length, failed, results }));
  } else {
    const written = results.length - failed;
    console.log(
      `${failed ? yellow('!') : green('✓')} ${written} written, ${failed} failed ${dim(`· ${collection} on ${ctx.site}`)}`,
    );
  }
}

/** Human lines per row (skipped under --json); sets a failing exit code either way. */
function report(ctx: Ctx, collection: string, results: PutResult[]): void {
  for (const r of results) {
    if (!r.ok) process.exitCode = 1;
    if (ctx.json) continue;
    const where = r.line === undefined ? '' : dim(`line ${r.line} `);
    if (r.ok) {
      const verb = r.status === 201 ? 'created' : 'replaced';
      // A batch names the site once, in its summary line.
      const site = r.line === undefined ? ` ${dim(`on ${ctx.site}`)}` : '';
      console.log(`${green('✓')} ${where}${verb} ${bold(`${collection}/${r.id}`)}${site}`);
    } else {
      console.error(`${yellow('✗')} ${where}${r.id ?? ''}${r.id ? ': ' : ''}${r.error}`);
    }
  }
}
