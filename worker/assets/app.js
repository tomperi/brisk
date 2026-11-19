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

/** Selected labels as removable chips, then every other label on the visible
 *  rows with how many of them carry it: a click never empties the list. */
function renderLabelBar(visible) {
  const counts = new Map();
  for (const site of visible) {
    for (const label of site.labels ?? []) {
      if (!selected.has(label)) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  const chips = [...selected].map((label) => {
    const chip = labelButton(label, 'chip');
    chip.title = `stop filtering by ${label}`;
    chip.append(cell('x', '×'));
    return chip;
  });
  const facets = [...counts]
    .sort(([a, n], [b, m]) => m - n || a.localeCompare(b))
    .map(([label, n]) => {
      const facet = labelButton(label, 'label facet');
      facet.title = `only sites labelled ${label}`;
      facet.append(cell('n', String(n)));
      return facet;
    });
  const bar = $('label-filter');
  bar.replaceChildren(...chips, ...facets);
  bar.hidden = !bar.childElementCount;
}

// ---- label editing ---------------------------------------------------------------
// Members change a row's labels in place (PATCH /api/sites/:name/labels); signed-out
// visitors on a public instance only read and filter.

let canEdit = false;
let editing = null; // the name of the site whose labels are open for editing
let labelError = null; // { site, text }: shown only in that site's editor
let draft = { site: null, value: '' }; // what the user is typing, kept across renders
let saving = Promise.resolve(); // label changes go one at a time, so responses land in order
let savedDuringLoad = null; // Map(name → labels) of saves that land while load() fetches
let focusLabelInput = false;
let focusEditButton = null; // the site whose editor just closed: focus goes back to its button

window.briskWhoami?.then((user) => {
  canEdit = Boolean(user);
  if (sites.length) render();
});

function toggleEditing(name) {
  editing = editing === name ? null : name;
  labelError = null;
  draft = { site: editing, value: '' };
  focusLabelInput = editing !== null;
  focusEditButton = editing === null ? name : null;
  render();
}

function changeLabels(site, change, typed = '') {
  saving = saving.then(() => saveLabels(site, change, typed));
}

async function saveLabels(site, change, typed) {
  let error = '';
  try {
    const res = await fetch(`/api/sites/${encodeURIComponent(site.name)}/labels`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(change),
    });
    const info = await res.json().catch(() => ({}));
    if (res.ok) {
      // load() may have swapped `sites` for fresh objects since this save was queued.
      for (const s of [site, sites.find((s) => s.name === site.name)])
        if (s) s.labels = info.labels;
      savedDuringLoad?.set(site.name, info.labels);
    } else error = info.error ?? `couldn't save the labels (${res.status})`;
  } catch {
    error = "couldn't reach the server — try again";
  }
  if (error) labelError = { site: site.name, text: error };
  else if (labelError?.site === site.name) labelError = null;
  // A saved add clears the input only if it still holds what was sent.
  if (!error && typed && draft.site === site.name && draft.value === typed) draft.value = '';
  render();
}

/** Every label in use, most used first, minus the ones this site already has. */
function labelOptions(site) {
  const counts = new Map();
  for (const s of sites) for (const l of s.labels ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);
  const options = $('label-options');
  options.replaceChildren(
    ...[...counts]
      .filter(([label]) => !(site.labels ?? []).includes(label))
      .sort(([a, n], [b, m]) => m - n || a.localeCompare(b))
      .map(([label]) => Object.assign(document.createElement('option'), { value: label })),
  );
}

function labelEditor(site) {
  const line = document.createElement('span');
  line.className = 'labels editing';
  for (const label of site.labels ?? []) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `#${label}`;
    chip.title = `remove ${label} from ${site.name}`;
    chip.append(cell('x', '×'));
    chip.addEventListener('click', () => {
      $('label-input')?.focus();
      changeLabels(site, { remove: [label] });
    });
    line.append(chip);
  }
  labelOptions(site);
  const input = document.createElement('input');
  input.id = 'label-input';
  input.className = 'label-input';
  input.setAttribute('list', 'label-options');
  input.placeholder = (site.labels ?? []).length ? 'add another' : 'add a label';
  input.autocomplete = 'off';
  input.value = draft.site === site.name ? draft.value : '';
  input.addEventListener('input', () => {
    draft = { site: site.name, value: input.value };
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return toggleEditing(site.name);
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const add = input.value.split(',').filter((l) => l.trim());
    changeLabels(site, { add }, input.value);
  });
  line.append(input);
  if (labelError?.site === site.name) line.append(cell('label-error', labelError.text));
  return line;
}

function render() {
  const list = $('site-list');
  const typing = document.activeElement?.id === 'label-input';
  const onEditButton = document.activeElement?.classList?.contains('edit-labels')
    ? document.activeElement.closest('li')?.dataset.site
    : null;
  const typed = $('filter').value.trim();
  const visible = sites.filter(
    (s) =>
      matches(s, typed.toLowerCase()) &&
      [...selected].every((label) => (s.labels ?? []).includes(label)),
  );
  // An edit can filter its own row out (removing the selected label): close it.
  if (editing && !visible.some((s) => s.name === editing)) editing = null;
  renderLabelBar(visible);
  const total = `${sites.length} ${sites.length === 1 ? 'site' : 'sites'}`;
  $('site-count').textContent =
    typed || selected.size
      ? `${visible.length} of ${total}, freshest first`
      : `${total}, freshest first`;
  list.replaceChildren(
    ...visible.map((site) => {
      const li = document.createElement('li');
      li.className = 'site-row';
      li.dataset.site = site.name;

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

      const actions = document.createElement('span');
      actions.className = 'actions';
      if (canEdit) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = editing === site.name ? 'copy edit-labels on' : 'copy edit-labels';
        edit.textContent = 'labels';
        edit.title =
          editing === site.name ? 'stop editing labels' : `edit the labels of ${site.name}`;
        edit.addEventListener('click', () => toggleEditing(site.name));
        actions.append(edit);
      }
      actions.append(copy);

      li.append(name, files, size, when, by, actions);

      // Their own line under the name, and only on rows that have any.
      if (editing === site.name) {
        li.classList.add('editing');
        li.append(labelEditor(site));
      } else if (site.labels?.length) {
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
  if (focusLabelInput || typing) {
    focusLabelInput = false;
    $('label-input')?.focus();
  }
  const button = focusEditButton ?? onEditButton;
  if (button) list.querySelector(`[data-site="${CSS.escape(button)}"] .edit-labels`)?.focus();
  focusEditButton = null;
}

function cell(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

async function load() {
  // Fetch after queued label saves, and keep any that land while the fetch is out.
  await saving;
  savedDuringLoad = new Map();
  const res = await fetch('/api/sites').catch(() => null);
  const fresh = res?.ok ? await res.json() : null;
  const saved = savedDuringLoad;
  savedDuringLoad = null;
  if (!fresh) {
    const section = $('sites-section');
    section.hidden = false;
    $('site-count').textContent =
      `couldn't load sites (${res?.status ?? 'offline'}) — try reloading`;
    showFilter(false);
    return;
  }
  ({ sites } = fresh);
  for (const s of sites) if (saved.has(s.name)) s.labels = saved.get(s.name);

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
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (e.key === '/' && !$('filter').hidden && !typing) {
    e.preventDefault();
    $('filter').focus();
  }
});

load();
