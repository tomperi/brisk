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
  [site.owner, site.updatedBy].some((label) => label?.toLowerCase().includes(needle)) ||
  (site.labels ?? []).some((label) => label.includes(needle));

// ---- label filter -----------------------------------------------------------------
// The selected labels live in the URL (?labels=marketing,dashboard) so a filtered
// view is a link you can share. A site shows only when it has every one of them.

const selectedFromUrl = () =>
  new Set(
    (new URLSearchParams(location.search).get('labels') ?? '')
      .split(',')
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  );

let selected = selectedFromUrl();

function setSelected(next) {
  selected = next;
  const url = new URL(location.href);
  if (selected.size) url.searchParams.set('labels', [...selected].join(','));
  else url.searchParams.delete('labels');
  // Commas read better than %2C in a link people paste around.
  history.pushState(null, '', url.href.replace(/%2C/gi, ','));
  render();
}

const toggleLabel = (label) => {
  const next = new Set(selected);
  if (!next.delete(label)) next.add(label);
  setSelected(next);
};

addEventListener('popstate', () => {
  selected = selectedFromUrl();
  render();
});

function labelButton(label, className) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = `#${label}`;
  b.addEventListener('click', () => toggleLabel(label));
  return b;
}

function renderChips() {
  const bar = $('label-filter');
  bar.hidden = !selected.size;
  bar.replaceChildren(
    ...[...selected].map((label) => {
      const chip = labelButton(label, 'chip');
      chip.title = `stop filtering by ${label}`;
      chip.append(cell('x', '×'));
      return chip;
    }),
  );
}

function render() {
  renderChips();
  const list = $('site-list');
  const typed = $('filter').value.trim();
  const visible = sites.filter(
    (s) =>
      matches(s, typed.toLowerCase()) &&
      [...selected].every((label) => (s.labels ?? []).includes(label)),
  );
  const total = `${sites.length} ${sites.length === 1 ? 'site' : 'sites'}`;
  $('site-count').textContent =
    typed || selected.size
      ? `${visible.length} of ${total}, freshest first`
      : `${total}, freshest first`;
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

      // Their own line under the name, and only on rows that have any.
      if (site.labels?.length) {
        const labels = document.createElement('span');
        labels.className = 'labels';
        for (const label of site.labels) {
          const tag = labelButton(label, selected.has(label) ? 'label on' : 'label');
          tag.title = selected.has(label)
            ? `stop filtering by ${label}`
            : `only sites labelled ${label}`;
          labels.append(tag);
        }
        li.append(labels);
      }
      return li;
    }),
  );
  if (!visible.length && (typed || selected.size)) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    const wanted = [typed && `“${typed}”`, ...[...selected].map((l) => `#${l}`)].filter(Boolean);
    li.textContent = `nothing matches ${wanted.join(' + ')}`;
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
