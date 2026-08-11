// Drag-and-drop deploys: drag a folder anywhere onto the dashboard, name it,
// launch. Members only — visitors never see the overlay. Inspired by Quick's
// original drop-to-deploy demo, in Brisk's paper-and-ink dialect.

(async () => {
  if (!(await window.briskWhoami)) return;

  const $ = (id) => document.getElementById(id);
  const overlay = $('drop-overlay');
  const stages = { over: $('stage-over'), name: $('stage-name'), live: $('stage-live') };
  const nameInput = $('site-name');
  const launch = $('launch');

  $('drop-hint').hidden = false;

  const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);
  const MAX_FILES = 2000;
  const MAX_BYTES = 50 * 1024 * 1024;
  const USERNAME_KEY = 'brisk-username';

  let dropped = []; // [{ path, file }]
  let stage = null;
  let shipping = false;
  /** Set once the server has told us this name is owned by someone else, so the
   *  next launch may overwrite it. Cleared whenever the name changes. */
  let armedForce = false;

  function show(next) {
    stage = next;
    overlay.hidden = false;
    for (const [key, el] of Object.entries(stages)) el.hidden = key !== next;
    $('drop-dismiss').hidden = next === 'over';
  }

  function reset() {
    overlay.hidden = true;
    stage = null;
    dropped = [];
    shipping = false;
    // Dismissing ends the flow the 409 armed this for. Leaving it set would let
    // the next drop overwrite a site someone else owns with no confirmation —
    // a prefilled name box can go straight to launch without an input event.
    armedForce = false;
    $('drop-error').hidden = true;
    $('drop-note').hidden = true;
    launch.disabled = false;
    launch.textContent = 'launch';
  }

  function fail(message) {
    const el = $('drop-error');
    el.textContent = message;
    el.hidden = false;
  }

  // ---- collecting what was dropped -------------------------------------------

  const entryFile = (entry) => new Promise((res, rej) => entry.file(res, rej));
  const readBatch = (reader) => new Promise((res, rej) => reader.readEntries(res, rej));

  async function walk(entry, prefix, out) {
    if (SKIP.has(entry.name)) return;
    if (entry.isFile) {
      out.push({ path: prefix + entry.name, file: await entryFile(entry) });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await readBatch(reader);
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
      }
    }
  }

  /** Returns { files, defaultName }. A single dropped folder becomes the root. */
  async function collect(dataTransfer) {
    const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const out = [];
    if (entries.length === 1 && entries[0].isDirectory) {
      const root = entries[0].createReader();
      for (;;) {
        const batch = await readBatch(root);
        if (!batch.length) break;
        for (const child of batch) await walk(child, '', out);
      }
      return { files: out, defaultName: entries[0].name };
    }
    for (const entry of entries) await walk(entry, '', out);
    if (!out.length) {
      // No filesystem entries (synthetic drops, odd browsers): take flat files.
      for (const file of dataTransfer.files) out.push({ path: file.name, file });
    }
    // One file is a one-page site — name it after the file, extension dropped,
    // the way a folder drop is named after the folder. The server serves a lone
    // page at the root, so it lands live at `/`.
    const single = out.length === 1 ? out[0].path.replace(/\.[^./]+$/, '') : '';
    return { files: out, defaultName: single };
  }

  // ---- the name stage ----------------------------------------------------------

  const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  function subdomainMode() {
    const first = (window.sites ?? sites ?? [])[0];
    if (first?.url) return first.url.startsWith(`${location.protocol}//${first.name}.`);
    return location.hostname !== 'localhost';
  }

  function refreshNote() {
    const name = nameInput.value;
    const exists = (sites ?? []).some((s) => s.name === name);
    launch.textContent = exists ? 'overwrite' : 'launch';
    $('drop-note').hidden = !exists;
    if (exists)
      $('drop-note').textContent =
        `“${name}” exists — launching replaces it. that's the deal here.`;
  }

  function prepareNameStage(defaultName) {
    const bytes = dropped.reduce((sum, f) => sum + f.file.size, 0);
    $('drop-count').textContent =
      `${dropped.length} ${dropped.length === 1 ? 'file' : 'files'} ready · ${humanBytes(bytes)}`;
    $('name-suffix').textContent = subdomainMode() ? `.${location.host}` : ` → /s/…/`;
    nameInput.value = slugify(defaultName);
    $('deploy-username').value = localStorage.getItem(USERNAME_KEY) ?? '';
    show('name');
    refreshNote();
    nameInput.focus();
    nameInput.select();

    if (dropped.length > MAX_FILES)
      fail(`that's ${dropped.length} files — the limit is ${MAX_FILES}`);
    else if (bytes > MAX_BYTES)
      fail(`that's ${humanBytes(bytes)} — keep deploys under ${humanBytes(MAX_BYTES)}`);
  }

  nameInput.addEventListener('input', () => {
    const clean = slugify(nameInput.value);
    if (nameInput.value !== clean) nameInput.value = clean;
    $('drop-error').hidden = true;
    // A different name is a different site: any pending overwrite no longer applies.
    armedForce = false;
    launch.textContent = 'launch';
    refreshNote();
  });

  stages.name.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (shipping) return;
    const name = nameInput.value;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
      return fail('names are lowercase letters, digits, and dashes');
    }
    const bytes = dropped.reduce((sum, f) => sum + f.file.size, 0);
    if (dropped.length > MAX_FILES || bytes > MAX_BYTES) return;

    shipping = true;
    launch.disabled = true;
    launch.textContent = 'shipping…';
    $('drop-error').hidden = true;

    const form = new FormData();
    for (const { path, file } of dropped) form.append('files', file, path);

    // The self-asserted deployer, same header the CLI sends. Remembered so you
    // name yourself once, not on every drop.
    const username = $('deploy-username').value.trim();
    if (username) localStorage.setItem(USERNAME_KEY, username);
    else localStorage.removeItem(USERNAME_KEY);

    try {
      const res = await fetch(`/api/deploy/${name}${armedForce ? '?force=1' : ''}`, {
        method: 'POST',
        body: form,
        headers: username ? { 'x-brisk-username': username } : {},
      });
      const info = await res.json().catch(() => ({}));

      // Someone else owns this site. Mirror the CLI's confirm rather than forcing
      // silently: the next launch — and only for this name — carries ?force=1.
      if (res.status === 409 && info.code === 'owned') {
        armedForce = true;
        launch.textContent = 'overwrite';
        throw new Error(`${name} belongs to ${info.owner} — launch again to overwrite it`);
      }
      if (!res.ok) throw new Error(info.error ?? `deploy failed (${res.status})`);
      armedForce = false;

      // A lone page is served at the site root; a lone anything-else is not, so
      // point at the file rather than a root that answers 404 — same call the
      // CLI makes. The site keeps the name either way.
      const only = dropped.length === 1 ? dropped[0].path : '';
      const live = only && !/\.html?$/i.test(only) ? info.url + encodeURIComponent(only) : info.url;
      const link = $('live-link');
      link.textContent = live.replace(/^https?:\/\//, '').replace(/\/$/, '');
      link.href = live;
      show('live');
      confetti();
      load(); // refresh the dashboard's site list behind the overlay
    } catch (err) {
      fail(err.message);
      launch.disabled = false;
      launch.textContent = armedForce ? 'overwrite' : 'launch';
    } finally {
      shipping = false;
    }
  });

  // ---- window-level drag wiring ---------------------------------------------------

  const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
  let depth = 0;

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    if (stage === null || stage === 'over') {
      const n = e.dataTransfer.items?.length || 0;
      $('drop-headline').textContent = n > 1 ? `${n} items ready to deploy` : 'drop to deploy';
      show('over');
    }
  });

  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });

  window.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      if (stage === 'over') reset();
    }
  });

  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    if (stage !== 'over') return; // mid-flow drops are ignored; esc first
    const { files, defaultName } = await collect(e.dataTransfer);
    if (!files.length) return reset();
    dropped = files;
    prepareNameStage(defaultName);
  });

  $('drop-dismiss').addEventListener('click', reset);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !shipping) reset();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stage && !shipping) reset();
  });

  // ---- the fun part -----------------------------------------------------------------

  function confetti() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti';
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    ctx.scale(devicePixelRatio, devicePixelRatio);

    const styles = getComputedStyle(document.documentElement);
    const colors = ['--accent', '--live', '--ink']
      .map((v) => styles.getPropertyValue(v).trim())
      .concat(['#e8b22a', '#d14f4f']);

    const origin = $('drop-card').getBoundingClientRect();
    const pieces = Array.from({ length: 140 }, () => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const speed = 7 + Math.random() * 9;
      return {
        x: origin.left + origin.width / 2 + (Math.random() - 0.5) * origin.width * 0.6,
        y: origin.top,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        spin: (Math.random() - 0.5) * 0.4,
        rot: Math.random() * Math.PI,
        w: 5 + Math.random() * 6,
        h: 3 + Math.random() * 4,
        color: colors[Math.floor(Math.random() * colors.length)],
      };
    });

    const started = performance.now();
    (function frame(now) {
      const t = (now ?? performance.now()) - started;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of pieces) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.22; // gravity
        p.vx *= 0.99;
        p.rot += p.spin;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, 1 - t / 1600);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (t < 1600) requestAnimationFrame(frame);
      else canvas.remove();
    })();
  }
})();
