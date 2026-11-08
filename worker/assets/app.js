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

// Identity + the header presence dot are handled by the shared header.js, which
// exposes the resolved-user promise as window.briskWhoami (used below).

// ---- site list ----------------------------------------------------------------

let sites = [];

// `owner` is stamped at creation and `updatedBy` is the latest deployer, so a
// forced overwrite splits them — both count. `owner` is NULL on older sites.
const matches = (site, needle) =>
  site.name.includes(needle) ||
  [site.owner, site.updatedBy].some((label) => label?.toLowerCase().includes(needle));

function render() {
  const list = $('site-list');
  const typed = $('filter').value.trim();
  const visible = sites.filter((s) => matches(s, typed.toLowerCase()));
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
      const by = cell('meta by', site.updatedBy ?? '');
      by.title = site.updatedBy ?? '';

      const copy = document.createElement('button');
      copy.className = 'copy';
      copy.textContent = 'url';
      wireCopy(copy, site.url);

      li.append(name, files, size, when, by, copy);
      return li;
    }),
  );
  if (!visible.length && typed) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = `nothing matches “${typed}”`;
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
    showFilter(false);
    return;
  }
  ({ sites } = await res.json());

  if (!sites.length) {
    // The quickstart teaches deploying — pointless for signed-out visitors.
    if (await window.briskWhoami) {
      $('quickstart').hidden = false;
    } else {
      const section = $('sites-section');
      section.hidden = false;
      $('site-count').textContent = 'nothing deployed yet — sign in to ship the first site';
      showFilter(false);
    }
    return;
  }
  $('sites-section').hidden = false;
  $('site-count').textContent =
    `${sites.length} ${sites.length === 1 ? 'site' : 'sites'}, freshest first`;
  showFilter(sites.length >= 9);
  render();
}

/** Hiding the box clears it and repaints. Clearing alone fires no input event,
 *  so the rows a stale value was hiding would stay hidden with the only control
 *  that could bring them back gone from the page. */
function showFilter(on) {
  $('filter').hidden = !on;
  if (on || !$('filter').value) return;
  $('filter').value = '';
  render();
}

$('filter').addEventListener('input', () => render());

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !$('filter').hidden && document.activeElement !== $('filter')) {
    e.preventDefault();
    $('filter').focus();
  }
});

load();
