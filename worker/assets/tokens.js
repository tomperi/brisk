// Site tokens page: lists tokens, disables/enables/deletes them, and builds the
// `brisk token create` command (creation is CLI-only; see tokens.html).

const $ = (id) => document.getElementById(id);

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

const csv = (s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(',');

// ---- command builder ------------------------------------------------------------

function commandParts() {
  const label = $('new-label').value.trim() || 'ci';
  const sites = csv($('new-sites').value) || 'my-site';
  const scopes = [...document.querySelectorAll('.scope-picks input:checked')].map((i) => i.value);
  return [
    'brisk token create',
    `--server ${location.origin}`,
    `--label ${shellQuote(label)}`,
    `--site ${sites}`,
    `--scope ${scopes.join(',') || 'read'}`,
  ];
}

const buildCommand = () => commandParts().join(' ');

// One span per flag, so a wrapped command never splits a flag from its value.
function renderCommand() {
  const parts = commandParts().map((part) => {
    const span = document.createElement('span');
    span.className = 'cmd-part';
    span.textContent = part;
    return span;
  });
  $('new-cmd').replaceChildren(...parts.flatMap((p, i) => (i ? [' ', p] : [p])));
}

for (const input of document.querySelectorAll('#builder input')) {
  input.addEventListener('input', renderCommand);
}

$('new-copy').addEventListener('click', async () => {
  const button = $('new-copy');
  await navigator.clipboard.writeText(buildCommand());
  button.textContent = 'copied';
  button.classList.add('done');
  setTimeout(() => {
    button.textContent = 'copy';
    button.classList.remove('done');
  }, 1200);
});

// ---- token list -------------------------------------------------------------------

let tokens = [];

function cell(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

async function send(id, init) {
  const res = await fetch(`/api/tokens/${encodeURIComponent(id)}`, {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return res.json();
}

function actionButton(text, onClick) {
  const button = document.createElement('button');
  button.className = 'copy';
  button.textContent = text;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await onClick(button);
    } catch (err) {
      $('token-count').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function row(token) {
  const li = document.createElement('li');
  li.className = `token-row${token.disabled ? ' is-disabled' : ''}`;

  const name = document.createElement('span');
  name.className = 'name';
  name.append(token.label, ' ', cell('token-id', token.id));
  name.title = `created by ${token.createdBy} ${timeAgo(token.createdAt)}`;

  // Enabling is CLI-only (like creating), so the page hands over the command.
  const toggle = token.disabled
    ? actionButton('copy enable cmd', async (button) => {
        await navigator.clipboard.writeText(
          `brisk token enable ${token.id} --server ${location.origin}`,
        );
        button.textContent = 'copied';
        button.classList.add('done');
        setTimeout(() => {
          button.textContent = 'copy enable cmd';
          button.classList.remove('done');
        }, 1200);
      })
    : actionButton('disable', async () => {
        const updated = await send(token.id, {
          method: 'PATCH',
          body: JSON.stringify({ disabled: true }),
        });
        tokens = tokens.map((t) => (t.id === updated.id ? updated : t));
        render();
      });

  // Two clicks, so a stray one can't break a CI pipeline.
  let armed = false;
  const remove = actionButton('delete', async (button) => {
    if (!armed) {
      armed = true;
      button.textContent = 'sure?';
      setTimeout(() => {
        armed = false;
        button.textContent = 'delete';
      }, 3000);
      return;
    }
    await send(token.id, { method: 'DELETE' });
    tokens = tokens.filter((t) => t.id !== token.id);
    render();
  });

  const actions = document.createElement('span');
  actions.className = 'token-actions';
  actions.append(toggle, remove);

  const main = document.createElement('div');
  main.className = 'token-main';
  const used = token.lastUsedAt ? `used ${timeAgo(token.lastUsedAt)}` : 'never used';
  main.append(
    name,
    cell('token-meta', `${token.sites.join(', ')} · ${token.scopes.join(', ')} · ${used}`),
  );

  li.append(main, cell('token-status', token.disabled ? 'disabled' : 'enabled'), actions);
  return li;
}

function render() {
  $('token-count').textContent = tokens.length
    ? `${tokens.length} ${tokens.length === 1 ? 'token' : 'tokens'}`
    : 'no tokens yet — build the command above and run it';
  $('token-list').replaceChildren(...tokens.map(row));
}

async function load() {
  if (!(await window.briskWhoami)) {
    $('tokens-section').hidden = false;
    $('token-count').textContent = 'sign in to manage site tokens';
    return;
  }
  $('builder').hidden = false;
  $('tokens-section').hidden = false;
  renderCommand();
  const res = await fetch('/api/tokens');
  if (!res.ok) {
    $('token-count').textContent = `couldn't load tokens (${res.status}) — try reloading`;
    return;
  }
  ({ tokens } = await res.json());
  render();
}

load();
