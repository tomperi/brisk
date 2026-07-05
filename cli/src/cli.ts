#!/usr/bin/env node
import { parseArgs } from 'node:util';
import * as commands from './commands.js';
import { bold, cyan, dim, yellow } from './ui.js';

const HELP = `${bold('brisk')} — drop a folder, get a site

${bold('Usage')}
  brisk init [name]            scaffold a new site folder
  brisk deploy [dir]           upload a folder, get a URL
  brisk dev [dir]              deploy on every file change
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

${bold('Options')}
  --site <name>                override the site name (default: brisk.json or folder name)
  --server <url>               target instance directly, e.g. brisk.example.com
  --profile <name>             use a specific profile for this command
  --username <name>            deploy identity / owner label (default: profile username)
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
  const { values, positionals } = parseArgs({
    options: {
      site: { type: 'string' },
      server: { type: 'string' },
      profile: { type: 'string' },
      username: { type: 'string' },
      force: { type: 'boolean', short: 'f' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
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
