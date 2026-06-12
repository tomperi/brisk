export const briskJson = (site: string): string => `${JSON.stringify({ site }, null, 2)}\n`;

export const starterHtml = (site: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${site}</title>
  <script src="/brisk.js"></script>
  <style>
    body { font: 18px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 2rem; }
  </style>
</head>
<body>
  <h1>${site}</h1>
  <p id="hello">…</p>
  <script>
    brisk.me().then((user) => {
      document.getElementById('hello').textContent = \`Hi \${user.name} — this page knows who you are, for free.\`;
    });
  </script>
</body>
</html>
`;

/**
 * Dropped into every initialized folder so coding agents know the platform.
 * This is the "your agent already has the skills" part of the DX.
 */
export const agentsMd = (site: string): string => `# ${site} — a Brisk site

This folder is a static site deployed with [Brisk](https://github.com/tomperi/brisk).
Plain HTML/CSS/JS — no framework, no build step. Deploy with \`brisk deploy\`.

## The zero-config backend

Every page can load the SDK and immediately use a database, file storage, AI,
realtime channels, and identity. No keys, no setup:

\`\`\`html
<script src="/brisk.js"></script>
\`\`\`

### Database — schemaless JSON collections, namespaced to this site
\`\`\`js
const posts = brisk.db.collection('posts');
const doc   = await posts.create({ title: 'Hello', votes: 0 });   // {id, createdAt, ...}
const all   = await posts.list({ sort: '-created', limit: 50 });
await posts.update(doc.id, { votes: 1 });   // shallow merge
await posts.delete(doc.id);
const stop  = posts.subscribe({                                    // realtime
  onCreate: (doc) => {}, onUpdate: (doc) => {}, onDelete: (id) => {},
});
\`\`\`

### Identity — who is looking at the page
\`\`\`js
const user = await brisk.me();   // { email, name, picture? }
\`\`\`

### AI — server holds the keys
\`\`\`js
const res = await brisk.ai.chat('Summarize this: ...');            // {text}
const res2 = await brisk.ai.chat([{ role: 'user', content: 'Hi' }], { system: '...' });
\`\`\`

### Files
\`\`\`js
const [file] = await brisk.fs.upload(input.files);   // {url, name, size, type}
\`\`\`

### Channels — realtime messaging + presence (multiplayer!)
\`\`\`js
const room = brisk.channel('lobby');
room.send({ x: 1 });                                  // to everyone else in the channel
room.on('message', (data, from) => {});               // from = {email, name}
room.on('presence', (members) => {});                 // fires on join/leave
\`\`\`

## Conventions

- Everything is client-side; there is no custom backend. If you need state, use \`brisk.db\`.
- Docs are plain JSON; design data shapes freely, there are no schemas or migrations.
- Keep it one folder of static files. \`index.html\` is the entry point.
- All \`brisk.*\` calls require a signed-in viewer. On public (view-only)
  instances, signed-out visitors get 401s — degrade gracefully if this site
  will be demoed publicly.
`;
