#!/usr/bin/env node
import { parseArgs } from 'node:util';
import * as commands from './commands.js';
import { db } from './db.js';
import { bold, cyan, dim, yellow } from './ui.js';

const HELP = `${bold('brisk')} — drop a folder, get a site

${bold('Usage')}
  brisk init [name]            scaffold a new site folder
  brisk deploy [dir|file]      upload a folder (or one html file), get a URL
  brisk dev [dir|file]         deploy on every file change
  brisk list                   all sites on the instance
  brisk open [site]            open a site in the browser
  brisk pull <site> [dir]      download a site's source to remix it

${bold('Accounts')}
  brisk login [server]         log in to an instance (creates a profile)
  brisk logout                 remove a profile
  brisk whoami                 who you are on the current instance
  brisk profiles               list profiles (● marks the active one)
  brisk profile use <name>     switch the active profile
  brisk profile set-username <name>  set your deploy identity on the active profile

${bold('Database')} ${dim('(the site’s brisk.db; the site comes from --site, brisk.json, or the folder)')}
  brisk db get <collection> <id>          print one doc
  brisk db list <collection>              oldest first; --limit <n> (default 100, max 500), --sort -created
  brisk db put <collection> <id>          create or fully replace a doc: JSON from --file <path> or stdin
  brisk db put <collection> --jsonl <f>   upsert many in one run: one {"id":…,"doc":{…}} per line
  brisk db delete <collection> <id>       delete a doc
                                          --json for machine output; --timeout <s> per request (default 30)

${bold('Plugins')}
  brisk plugin list                    installed plugins on the instance
  brisk plugin <id> --help             a plugin's actions (loaded from the server)
  brisk plugin <id> <action> [args…]   run an action, e.g. brisk plugin comments list <site>
                                       args are free text; put -- first if one starts with a dash

${bold('Options')}
  --site <name>                override the site name (default: brisk.json, folder, or file name)
  --server <url>               target instance directly, e.g. brisk.example.com
  --profile <name>             use a specific profile for this command
  --username <name>            deploy identity / owner label (default: profile username)
  --labels <a,b>               deploy with these labels (max 5), overriding brisk.json;
                               "" clears them. Without it, a redeploy keeps the site's labels
  -f, --force                  overwrite a site owned by someone else
  -y, --yes                    confirm deploying to an open (AUTH=none) public instance

${bold('Environment')}
  BRISK_PROFILE                like --profile
  BRISK_SERVER, BRISK_TOKEN    direct server + bearer token (CI)
  BRISK_USERNAME               like --username
  BRISK_FORCE                  like --force (agents / CI)
  BRISK_YES                    like --yes
`;

async function main(): Promise<void> {
  // `plugin` action args can be arbitrary free text (comment bodies, dashes),
  // which the strict global parseArgs would reject. Intercept it here — skipping
  // any leading global flags to find the command — and let commands.plugin do
  // its own lenient parsing. Leading --server/--profile pass through to it.
  const raw = process.argv.slice(2);
  const valueFlags = new Set([
    '--server',
    '--profile',
    '--site',
    '--username',
    '--labels',
    '--file',
    '--jsonl',
    '--limit',
    '--sort',
    '--timeout',
  ]);
  let pi = 0;
  while (pi < raw.length && raw[pi]!.startsWith('-')) {
    pi += valueFlags.has(raw[pi]!) ? 2 : 1;
  }
  if (raw[pi] === 'plugin') {
    return commands.plugin([...raw.slice(0, pi), ...raw.slice(pi + 1)]);
  }

  // parseArgs refuses a dash-leading value after a space, and `--sort -created`
  // is the natural spelling; glue it on as `--sort=-created`.
  const argv = raw.flatMap((a, i) =>
    raw[i - 1] === '--sort'
      ? []
      : a === '--sort' && i + 1 < raw.length
        ? [`--sort=${raw[i + 1]}`]
        : [a],
  );

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      site: { type: 'string' },
      server: { type: 'string' },
      profile: { type: 'string' },
      username: { type: 'string' },
      labels: { type: 'string' },
      force: { type: 'boolean', short: 'f' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
      // `brisk db` only. Ids and collections never start with a dash and doc
      // JSON arrives by file or stdin, so db needs no interception like plugin.
      file: { type: 'string' },
      jsonl: { type: 'string' },
      limit: { type: 'string' },
      sort: { type: 'string' },
      json: { type: 'boolean' },
      timeout: { type: 'string' },
    },
    allowPositionals: true,
  });

  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  const flags = {
    site: values.site,
    server: values.server,
    profile: values.profile,
    username: values.username,
    labels: values.labels,
    force: Boolean(values.force),
    yes: Boolean(values.yes),
  };
  switch (command) {
    case 'init':
      return commands.init(args[0], flags);
    case 'deploy':
      await commands.deploy(args[0], flags);
      return;
    case 'dev':
      return commands.dev(args[0], flags);
    case 'list':
    case 'ls':
      return commands.list(flags);
    case 'open':
      return commands.open(args[0], flags);
    case 'pull':
      if (!args[0]) throw new Error('usage: brisk pull <site> [dir]');
      return commands.pull(args[0], args[1], flags);
    case 'db':
      return db(args, {
        ...flags,
        file: values.file,
        jsonl: values.jsonl,
        limit: values.limit,
        sort: values.sort,
        json: Boolean(values.json),
        timeout: values.timeout,
      });
    case 'login':
      return commands.login(args[0], flags);
    case 'logout':
      return commands.logout(flags);
    case 'whoami':
      return commands.whoami(flags);
    case 'profiles':
      return commands.profiles();
    case 'profile':
      if (args[0] === 'use' && args[1]) return commands.profileUse(args[1]);
      if (args[0] === 'set-username' && args[1]) return commands.profileSetUsername(args[1]);
      if (args[0] === 'list' || !args[0]) return commands.profiles();
      throw new Error(
        'usage: brisk profile use <name> | brisk profile set-username <name> | brisk profiles',
      );
    default:
      console.log(`${yellow('unknown command:')} ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(`${yellow('error:')} ${err.message}`);
  if (err.message.includes('ECONNREFUSED')) {
    console.error(dim(`is the Brisk server running? try ${cyan('pnpm dev')} or set --server`));
  }
  process.exitCode = 1;
});
