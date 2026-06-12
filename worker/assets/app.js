// Dashboard logic. Dogfoods the Brisk SDK: identity via brisk.me(),
// the "n here now" dot via channel presence.

const $ = (id) => document.getElementById(id);

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function wireCopy(button, text) {
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text ?? button.dataset.copy);
    button.classList.add('done');
    const label = button.textContent;
    button.textContent = 'copied';
    setTimeout(() => {
      button.classList.remove('done');
      button.textContent = label;
    }, 1200);
  });
}

document.querySelectorAll('.copy[data-copy]').forEach((b) => wireCopy(b));

// ---- identity + presence ----------------------------------------------------

brisk.me().then((user) => {
  $('who').textContent = user.name === 'Dev' ? user.email : user.name.toLowerCase();
  $('whoami').hidden = false;
});

const lobby = brisk.channel('dashboard');
lobby.on('presence', (members) => {
  const others = members.length - 1;
  $('presence').hidden = others < 1;
  if (others >= 1)
    $('presence').title = `${others} other ${others === 1 ? 'person' : 'people'} here now`;
});

// ---- site list ----------------------------------------------------------------

let sites = [];

function render(filter = '') {
  const list = $('site-list');
  const visible = sites.filter((s) => s.name.includes(filter.toLowerCase()));
  list.replaceChildren(
    ...visible.map((site) => {
      const li = document.createElement('li');
      li.className = 'site-row';

      const name = document.createElement('a');
      name.className = 'name';
      name.href = site.url;
      name.textContent = site.name;

      const files = cell('meta files', `${site.files} files`);
      const size = cell('meta size', humanBytes(site.bytes));
      const when = cell('meta', timeAgo(site.updatedAt));
      const by = cell('meta by', site.updatedBy ? site.updatedBy.split('@')[0] : '');
      by.title = site.updatedBy ?? '';

      const copy = document.createElement('button');
      copy.className = 'copy';
      copy.textContent = 'url';
      wireCopy(copy, site.url);

      li.append(name, files, size, when, by, copy);
      return li;
    }),
  );
  if (!visible.length && filter) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = `nothing matches “${filter}”`;
    list.append(li);
  }
}

function cell(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

async function load() {
  const res = await fetch('/api/sites');
  if (!res.ok) {
    const section = $('sites-section');
    section.hidden = false;
    $('site-count').textContent = `couldn't load sites (${res.status}) — try reloading`;
    $('filter').hidden = true;
    return;
  }
  ({ sites } = await res.json());

  if (!sites.length) {
    $('quickstart').hidden = false;
    return;
  }
  $('sites-section').hidden = false;
  $('site-count').textContent =
    `${sites.length} ${sites.length === 1 ? 'site' : 'sites'}, freshest first`;
  $('filter').hidden = sites.length < 9;
  render();
}

$('filter').addEventListener('input', (e) => render(e.target.value.trim()));

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('filter')) {
    e.preventDefault();
    $('filter').focus();
  }
});

load();
