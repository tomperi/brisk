import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  ApiError,
  api,
  authHeaders,
  globalConfigPath,
  loadConfig,
  loadGlobal,
  normalizeServer,
  resolveConnection,
  resolveUsername,
  saveGlobal,
  type Connection,
} from './config.js';
import { agentsMd, briskJson, starterHtml } from './templates.js';
import { bold, cyan, dim, green, humanBytes, spinner, timeAgo, yellow } from './ui.js';

export interface Flags {
  site?: string;
  server?: string;
  profile?: string;
  username?: string;
  force?: boolean;
  yes?: boolean;
}

interface SiteInfo {
  name: string;
  files: number;
  bytes: number;
  updatedAt: string;
  updatedBy: string | null;
  owner: string | null;
  url: string;
}

const SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'brisk.json']);

function resolveSite(dir: string, flags: Flags): string {
  const site = flags.site ?? loadConfig(dir).site ?? path.basename(path.resolve(dir));
  return slugify(site);
}

/** Folder names become site names: lowercase dns labels, nothing fancier. */
const slugify = (name: string): string => name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

async function collectFiles(dir: string): Promise<{ rel: string; abs: string }[]> {
  const out: { rel: string; abs: string }[] = [];
  for (const entry of await fsp.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, abs).split(path.sep).join('/');
    if (rel.split('/').some((part) => SKIP.has(part))) continue;
    out.push({ rel, abs });
  }
  return out;
}

function openInBrowser(url: string): void {
  // `start` is a cmd builtin; the empty title argument keeps URLs with & intact.
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

/** Mirror of worker/src/auth.ts isLocalHost — the one host set that's "local". */
function isLocalServer(server: string): boolean {
  const h = new URL(server).hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost');
}

/**
 * Deploying to a NON-local instance that runs open (AUTH=none) pushes code to a
 * platform where every anonymous visitor is a full member — they can deploy over
 * or delete every site there and spend its AI/storage budget. Confirm intent
 * first. This never blocks unconditionally and changes nothing about the trust
 * model; it only makes an easy-to-miss exposure impossible to hit silently.
 * Detected with zero server changes: an open instance reports the dev identity.
 */
async function confirmOpenTarget(conn: Connection, flags: Flags): Promise<void> {
  if (isLocalServer(conn.server)) return;
  let open = false;
  try {
    const me = await api<{ email: string }>(conn, '/api/me');
    open = me.email === 'dev@localhost';
  } catch {
    return; // a server that requires auth (or errors) isn't an open one
  }
  if (!open) return;

  console.error(
    `${yellow('warning:')} ${bold(conn.server)} runs ${bold('open')} (${dim('AUTH=none')}) on a ` +
      `public host —\n  anyone who reaches it is a full member who can overwrite or delete every site there.`,
  );
  if (flags.yes || ['1', 'true'].includes(process.env.BRISK_YES ?? '')) return;
  if (!process.stdin.isTTY) {
    throw new Error(
      'refusing to deploy to an open public instance non-interactively — pass --yes (-y) or BRISK_YES=1 to confirm',
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((res) => rl.question('Deploy anyway? [y/N] ', res));
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error('aborted');
}

// ---- commands ---------------------------------------------------------------

export async function init(name: string | undefined, flags: Flags): Promise<void> {
  const dir = name ? path.resolve(name) : process.cwd();
  const site = slugify(name ?? path.basename(dir));
  await fsp.mkdir(dir, { recursive: true });

  const write = async (file: string, content: string) => {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) {
      console.log(dim(`  skip ${file} (exists)`));
      return;
    }
    await fsp.writeFile(target, content);
    console.log(`  ${green('+')} ${file}`);
  };

  console.log(`${bold('brisk init')} ${cyan(site)}`);
  await write('brisk.json', briskJson(site));
  await write('index.html', starterHtml(site));
  await write('AGENTS.md', agentsMd(site));
  console.log(`\nNext: ${bold(`brisk deploy${name ? ` ${name}` : ''}`)}`);
}

export async function deploy(
  dirArg: string | undefined,
  flags: Flags,
  // Invoked when a deploy overwrites someone else's site after an interactive
  // confirm — lets `dev` make the rest of the watch session force silently.
  onOverwrite?: () => void,
): Promise<SiteInfo | undefined> {
  const dir = path.resolve(dirArg ?? '.');
  const site = resolveSite(dir, flags);
  const conn = resolveConnection(flags, dir);
  // Open-instance gate first (are we shipping to a public AUTH=none host?),
  // independent of the ownership overwrite gate below.
  await confirmOpenTarget(conn, flags);
  const username = resolveUsername(flags, conn);

  const files = await collectFiles(dir);
  if (!files.length) throw new Error(`nothing to deploy in ${dir}`);

  const form = new FormData();
  for (const { rel, abs } of files) {
    form.append('files', new File([await fsp.readFile(abs)], rel));
  }

  const headers: Record<string, string> = username ? { 'x-brisk-username': username } : {};

  const send = async (force: boolean): Promise<SiteInfo> => {
    const started = Date.now();
    const spin = spinner(`Deploying ${bold(site)}…`);
    let info: SiteInfo;
    try {
      info = await api<SiteInfo>(conn, `/api/deploy/${site}${force ? '?force=1' : ''}`, {
        method: 'POST',
        body: form,
        headers,
      });
    } finally {
      spin.stop();
    }
    console.log(
      `${green('✓')} ${bold(site)} ${dim(`· ${info.files} ${info.files === 1 ? 'file' : 'files'} · ${humanBytes(info.bytes)} · ${Date.now() - started}ms`)}`,
    );
    console.log(`  ${cyan(info.url)}`);
    return info;
  };

  const forced = Boolean(flags.force) || ['1', 'true'].includes(process.env.BRISK_FORCE ?? '');
  try {
    return await send(forced);
  } catch (err) {
    const owner = err instanceof ApiError && err.status === 409 ? ownedBy(err.body) : null;
    if (owner === null) throw err;
    // Deploying over someone else's site: confirm interactively, but never read
    // stdin when it isn't a TTY — an agent or CI job must not hang on a prompt.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const ok = await confirm(`site "${site}" is owned by ${owner}. overwrite? [y/N] `);
      if (ok) {
        onOverwrite?.();
        return await send(true);
      }
      console.log(dim('aborted — nothing deployed'));
      return undefined;
    }
    throw new Error(
      `site "${site}" is owned by ${owner}; pass --force (or BRISK_FORCE=1) to overwrite`,
    );
  }
}

/** The owner named by a 409 `owned` deploy response, or null for anything else. */
function ownedBy(body: unknown): string | null {
  if (body && typeof body === 'object' && (body as { code?: unknown }).code === 'owned') {
    const owner = (body as { owner?: unknown }).owner;
    return typeof owner === 'string' ? owner : 'someone else';
  }
  return null;
}

/** Single yes/no prompt on the TTY. Only `y`/`yes` (any case) confirm. */
function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    }),
  );
}

/** Deploy on every save — the whole "dev server" Brisk needs. */
export async function dev(dirArg: string | undefined, flags: Flags): Promise<void> {
  const dir = path.resolve(dirArg ?? '.');
  // Owner is set-once, so overwriting another owner's site would re-prompt on
  // every save. Confirm (or --force) once, then force the rest of the session.
  let force = Boolean(flags.force) || ['1', 'true'].includes(process.env.BRISK_FORCE ?? '');
  const stick = (): void => {
    force = true;
  };
  await deploy(dirArg, { ...flags, force }, stick);
  // The open-instance confirm likewise happens once; skip it on every re-deploy.
  flags = { ...flags, yes: true };
  console.log(dim('\nwatching for changes — ctrl-c to stop'));

  let timer: NodeJS.Timeout | null = null;
  let deploying = false;
  let dirty = false;

  const redeploy = async (): Promise<void> => {
    if (deploying) {
      dirty = true; // a save landed mid-deploy; go again when this one ends
      return;
    }
    deploying = true;
    try {
      await deploy(dirArg, { ...flags, force }, stick);
    } catch (err) {
      console.error(yellow(`deploy failed: ${(err as Error).message}`));
    } finally {
      deploying = false;
      if (dirty) {
        dirty = false;
        void redeploy();
      }
    }
  };

  fs.watch(dir, { recursive: true }, (_event, file) => {
    if (!file || file.split(path.sep).some((part) => SKIP.has(part))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(redeploy, 300);
  });
  await new Promise(() => {}); // run until interrupted
}

export async function list(flags: Flags): Promise<void> {
  const conn = resolveConnection(flags, process.cwd());
  const { sites } = await api<{ sites: SiteInfo[] }>(conn, '/api/sites');
  if (!sites.length) {
    console.log(`No sites yet. ${dim('Try: brisk init my-site && brisk deploy my-site')}`);
    return;
  }
  const width = Math.max(...sites.map((s) => s.name.length)) + 2;
  for (const s of sites) {
    console.log(
      `${bold(s.name.padEnd(width))}${dim(
        `${String(s.files).padStart(4)} files  ${humanBytes(s.bytes).padStart(9)}  ${timeAgo(s.updatedAt).padStart(10)}`,
      )}  ${s.updatedBy ? dim(s.updatedBy) : ''}`,
    );
  }
}

export async function open(siteArg: string | undefined, flags: Flags): Promise<void> {
  const dir = process.cwd();
  const site = siteArg ?? resolveSite(dir, flags);
  const conn = resolveConnection(flags, dir);
  const info = await api<SiteInfo>(conn, `/api/sites/${site}`);
  console.log(cyan(info.url));
  openInBrowser(info.url);
}

/** Download a site's source — every site on Brisk is remixable. */
export async function pull(site: string, dirArg: string | undefined, flags: Flags): Promise<void> {
  const conn = resolveConnection(flags, process.cwd());
  const dir = path.resolve(dirArg ?? site);
  const { files } = await api<{ files: { path: string; size: number }[] }>(
    conn,
    `/api/sites/${site}/files`,
  );
  if (!files.length) throw new Error(`no such site: ${site}`);

  for (const file of files) {
    const res = await fetch(`${conn.server}/api/sites/${site}/raw/${file.path}`, {
      headers: authHeaders(conn),
    });
    if (!res.ok) throw new Error(`failed to fetch ${file.path}: ${res.status}`);
    const target = path.join(dir, file.path);
    if (!target.startsWith(dir + path.sep) && target !== dir) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, Buffer.from(await res.arrayBuffer()));
    console.log(`  ${green('+')} ${file.path} ${dim(humanBytes(file.size))}`);
  }
  console.log(`\n${green('✓')} pulled ${bold(site)} into ${cyan(dir)}`);
}

// ---- profiles & login ----------------------------------------------------------

const LOGIN_TIMEOUT_MS = 120_000;

/**
 * Browser-assisted login: we listen on localhost, the instance authenticates
 * the user (Google, if enabled) and redirects back with a personal token.
 */
export async function login(serverArg: string | undefined, flags: Flags): Promise<void> {
  const server = serverArg
    ? normalizeServer(serverArg)
    : resolveConnection({ ...flags, profile: undefined }, process.cwd()).server;
  const state = crypto.randomUUID();

  let spin: { stop: () => void } | null = null;
  const result = await new Promise<{ token?: string; email?: string; open?: boolean }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        listener.close();
        reject(new Error('login timed out — no callback from the browser'));
      }, LOGIN_TIMEOUT_MS);

      const listener = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
          res.writeHead(400).end('unexpected request');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<body style="font-family:monospace;padding:2rem">✓ logged in — you can close this tab</body>',
        );
        clearTimeout(timer);
        listener.close();
        resolve({
          token: url.searchParams.get('token') ?? undefined,
          email: url.searchParams.get('email') ?? undefined,
          open: url.searchParams.get('open') === '1',
        });
      });

      listener.listen(0, '127.0.0.1', () => {
        const { port } = listener.address() as { port: number };
        const loginUrl = `${server}/auth/cli?port=${port}&state=${state}`;
        console.log(`Opening browser… if it doesn't, visit:\n  ${cyan(loginUrl)}\n`);
        openInBrowser(loginUrl);
        spin = spinner('Waiting for the browser…');
      });
      listener.on('error', reject);
    },
  ).finally(() => spin?.stop());

  const cfg = loadGlobal();
  const name = flags.profile ?? new URL(server).hostname;
  cfg.profiles[name] = { server, token: result.token, email: result.email };
  cfg.current ??= name;
  saveGlobal(cfg);

  const who = result.open ? 'no login required on this instance' : (result.email ?? 'logged in');
  console.log(`${green('✓')} profile ${bold(name)} → ${cyan(server)} ${dim(`(${who})`)}`);
  if (cfg.current !== name) {
    console.log(
      dim(`active profile is still "${cfg.current}" — switch with: brisk profile use ${name}`),
    );
  }
}

export function logout(flags: Flags): void {
  const cfg = loadGlobal();
  const name = flags.profile ?? cfg.current;
  if (!name || !cfg.profiles[name]) throw new Error('no profile to log out of');
  delete cfg.profiles[name];
  if (cfg.current === name) cfg.current = Object.keys(cfg.profiles)[0];
  saveGlobal(cfg);
  console.log(`${green('✓')} removed profile ${bold(name)}`);
}

export async function whoami(flags: Flags): Promise<void> {
  const conn = resolveConnection(flags, process.cwd());
  const me = await api<{ email: string; name: string }>(conn, '/api/me');
  const via = conn.profile ? `profile ${bold(conn.profile)}` : dim('(no profile)');
  console.log(`${me.name} ${dim(`<${me.email}>`)} on ${cyan(conn.server)} via ${via}`);
  const username = resolveUsername(flags, conn);
  if (username) console.log(dim(`deploy username: ${username}`));
}

export function profiles(): void {
  const cfg = loadGlobal();
  const names = Object.keys(cfg.profiles);
  if (!names.length) {
    console.log(`No profiles yet. ${dim('Try: brisk login https://your-brisk-host')}`);
    return;
  }
  const width = Math.max(...names.map((n) => n.length)) + 2;
  for (const name of names) {
    const p = cfg.profiles[name]!;
    const marker = name === cfg.current ? green('●') : ' ';
    console.log(
      `${marker} ${bold(name.padEnd(width))}${cyan(p.server)}  ${dim(p.email ?? (p.token ? '' : 'no auth'))}`,
    );
  }
  console.log(dim(`\nconfig: ${globalConfigPath()}`));
}

export function profileUse(name: string): void {
  const cfg = loadGlobal();
  if (!cfg.profiles[name]) {
    throw new Error(`no profile "${name}" — known: ${Object.keys(cfg.profiles).join(', ')}`);
  }
  cfg.current = name;
  saveGlobal(cfg);
  console.log(
    `${green('✓')} active profile: ${bold(name)} ${dim(`(${cfg.profiles[name]!.server})`)}`,
  );
}

/** The deploy identity ships as a per-profile label, so it follows the instance
 *  you're pointed at. Sets it on the active profile. */
export function profileSetUsername(name: string): void {
  const cfg = loadGlobal();
  const active = cfg.current ? cfg.profiles[cfg.current] : undefined;
  if (!active) throw new Error('no active profile — run `brisk login` first');
  active.username = name;
  saveGlobal(cfg);
  console.log(`${green('✓')} deploy username on ${bold(cfg.current!)} → ${bold(name)}`);
}
