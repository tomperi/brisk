# Brisk SDK cheat-sheet

Load once per page: `<script src="/brisk.js"></script>`. Then the `brisk` global
is available — no keys, no imports, no async setup. All calls are namespaced to
the current site. This is the basics; the folder's `AGENTS.md` and `/docs` have
the complete reference.

## Database — schemaless JSON collections

```js
const posts = brisk.db.collection('posts');
const doc   = await posts.create({ title: 'Hello', votes: 0 }); // → {id, createdAt, updatedAt, ...}
const all   = await posts.list({ sort: '-created', limit: 50 }); // omit opts for oldest-first
const one   = await posts.get(doc.id);
await posts.update(doc.id, { votes: 1 });                        // shallow merge
await posts.delete(doc.id);

const stop = posts.subscribe({                                   // realtime; returns unsubscribe fn
  onCreate: (doc) => {},
  onUpdate: (doc) => {},
  onDelete: (id)  => {},
});
```

## Identity — who's looking at the page

```js
const user = await brisk.me();   // { email, name, picture? }
```

## AI — server holds the keys

```js
const r  = await brisk.ai.chat('Summarize this: ...');           // → { text, model, provider }
const r2 = await brisk.ai.chat(
  [{ role: 'user', content: 'Hi' }],
  { system: '...', model: '...', maxTokens: 1024 },
);
```

## Files — permanent URLs for uploads

```js
const [file] = await brisk.fs.upload(input.files); // File | File[] | FileList → [{ url, name, size, type }]
```

## Channels — realtime messaging + presence (multiplayer)

```js
const room = brisk.channel('lobby');
room.send({ x: 1 });                       // to everyone else in the channel
room.on('message',  (data, from) => {});   // from = { email, name, picture? }
room.on('presence', (members)    => {});   // fires on join/leave; members = User[]
room.members;                              // current members
room.leave();
```

## A complete minimal page

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>guestbook</title>
  <script src="/brisk.js"></script>
</head>
<body>
  <h1>Guestbook</h1>
  <form id="f"><input id="msg" placeholder="say hi" /><button>post</button></form>
  <ul id="list"></ul>
  <script>
    const entries = brisk.db.collection('entries');
    const list = document.getElementById('list');

    function add(doc) {
      const li = document.createElement('li');
      li.textContent = doc.msg;
      list.prepend(li);
    }

    (async () => {
      for (const doc of await entries.list({ sort: '-created' })) add(doc);
      entries.subscribe({ onCreate: add });
    })();

    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('msg');
      if (input.value.trim()) await entries.create({ msg: input.value.trim() });
      input.value = '';
    });
  </script>
</body>
</html>
```
