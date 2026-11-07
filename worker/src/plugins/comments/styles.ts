export const PANEL_W = 400;
/** Below this the panel overlays the page instead of pushing it aside. */
export const DOCK_MIN = 900;

/* Pins and the pick box sit on the teammate's page, not on the panel, so they
 * keep the light tokens whatever the OS scheme: the dark block only redeclares :host. */
export const WIDGET_CSS = `
:host, #pins, .hi {
  --panel-w: ${PANEL_W}px;
  --font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --bg: oklch(100% 0 0);
  --bg-subtle: oklch(98.5% 0.002 265);
  --bg-muted: oklch(96.7% 0.003 265);
  --line: oklch(92.8% 0.006 265);
  --line-strong: oklch(87.2% 0.009 265);
  --fg-faint: oklch(70.7% 0.019 265);
  --fg-muted: oklch(55.1% 0.023 265);
  --fg-2: oklch(44.6% 0.026 265);
  --fg-1: oklch(37.3% 0.031 265);
  --fg: oklch(21% 0.032 265);
  --accent: oklch(46% 0.19 262);
  --accent-hover: oklch(41% 0.19 262);
  --on-accent: oklch(100% 0 0);
  --accent-ink: oklch(42% 0.18 262);
  --accent-soft: oklch(97% 0.016 262);
  --accent-tint: oklch(93% 0.035 262);
  --accent-line: oklch(88% 0.06 262);
  --hl: oklch(46% 0.19 262 / 0.2);
  --hl-soft: oklch(46% 0.19 262 / 0.09);
  --hl-line: oklch(46% 0.19 262 / 0.45);
  --danger: oklch(51% 0.19 27);
  --danger-soft: oklch(96.5% 0.02 27);
  --av-l: 52%;
  --shadow-sm: 0 1px 2px oklch(21% 0.032 265 / 0.06);
  --shadow-pop: 0 1px 3px oklch(21% 0.032 265 / 0.08), 0 8px 24px oklch(21% 0.032 265 / 0.12);
  --shadow-pin: 0 1px 2px oklch(21% 0.032 265 / 0.2), 0 2px 6px oklch(21% 0.032 265 / 0.12);
  --shadow-panel: -4px 0 16px oklch(21% 0.032 265 / 0.05);
  --ease: cubic-bezier(0.23, 1, 0.32, 1);
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: oklch(18.5% 0.004 265);
    --bg-subtle: oklch(21% 0.005 265);
    --bg-muted: oklch(24.5% 0.006 265);
    --line: oklch(28.5% 0.006 265);
    --line-strong: oklch(36% 0.008 265);
    --fg-faint: oklch(52% 0.012 265);
    --fg-muted: oklch(68% 0.014 265);
    --fg-2: oklch(75% 0.012 265);
    --fg-1: oklch(84% 0.01 265);
    --fg: oklch(95% 0.005 265);
    --accent: oklch(72% 0.13 262);
    --accent-hover: oklch(77% 0.12 262);
    --on-accent: oklch(17% 0.03 262);
    --accent-ink: oklch(82% 0.09 262);
    --accent-soft: oklch(72% 0.13 262 / 0.1);
    --accent-tint: oklch(72% 0.13 262 / 0.22);
    --accent-line: oklch(72% 0.13 262 / 0.38);
    --hl: oklch(72% 0.13 262 / 0.3);
    --hl-soft: oklch(72% 0.13 262 / 0.15);
    --hl-line: oklch(72% 0.13 262 / 0.55);
    --danger: oklch(71% 0.15 25);
    --danger-soft: oklch(71% 0.15 25 / 0.12);
    --av-l: 48%;
    --shadow-sm: 0 1px 2px oklch(0% 0 0 / 0.3);
    --shadow-pop: 0 1px 3px oklch(0% 0 0 / 0.4), 0 8px 24px oklch(0% 0 0 / 0.45);
    --shadow-pin: 0 1px 2px oklch(0% 0 0 / 0.5), 0 2px 6px oklch(0% 0 0 / 0.35);
    --shadow-panel: -4px 0 16px oklch(0% 0 0 / 0.3);
  }
}
* { box-sizing: border-box; margin: 0; }
::selection { background: var(--accent-tint); color: var(--fg); }
.layer {
  position: fixed; inset: 0; pointer-events: none; color: var(--fg);
  font: 13px/20px var(--font); font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
}
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
textarea {
  font: inherit; color: var(--fg); caret-color: var(--accent); background: transparent;
  border: 0; resize: none; width: 100%; outline: none;
}
textarea::placeholder { color: var(--fg-muted); }
.i {
  width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5;
  stroke-linecap: round; stroke-linejoin: round;
}

/* controls */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px;
  padding: 0 12px; border-radius: 6px; font-weight: 500; font-size: 13px; line-height: 1;
  white-space: nowrap; border: 1px solid var(--line); background: var(--bg); color: var(--fg-1);
  box-shadow: var(--shadow-sm); pointer-events: auto;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 110ms var(--ease);
}
.btn:hover { background: var(--bg-subtle); color: var(--fg); }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.5; cursor: default; transform: none; }
.btn.pri { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn.pri:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn.sm { height: 28px; padding: 0 10px; font-size: 12px; }
.btn.ghost { border-color: transparent; box-shadow: none; background: none; color: var(--fg-muted); }
.btn.ghost:hover { background: var(--bg-muted); color: var(--fg); }
.btn.danger { background: var(--danger); border-color: var(--danger); color: var(--on-accent); }
.btn.danger:hover { background: var(--danger); filter: brightness(0.94); }
.ib {
  width: 32px; height: 32px; border-radius: 6px; display: grid; place-items: center; flex: none;
  color: var(--fg-muted); pointer-events: auto; position: relative;
  transition: background-color 120ms ease, color 120ms ease;
}
.ib:hover { background: var(--bg-muted); color: var(--fg); }
.ib.on { background: var(--accent-soft); color: var(--accent-ink); }
[data-tip]::after {
  content: attr(data-tip); position: absolute; top: calc(100% + 6px); right: 0; width: max-content;
  background: var(--fg); color: var(--bg); font: 500 12px/16px var(--font); padding: 4px 8px;
  border-radius: 6px; white-space: nowrap; opacity: 0; transform: translateY(-2px);
  pointer-events: none; transition: opacity 120ms ease, transform 120ms var(--ease); z-index: 5;
}
[data-tip]:hover::after { opacity: 1; transform: none; transition-delay: 400ms; }
.fab [data-tip]::after, .nub[data-tip]::after { top: auto; bottom: calc(100% + 8px); transform: translateY(2px); }
.n {
  font-size: 11px; line-height: 18px; min-width: 18px; padding: 0 5px; border-radius: 9px;
  background: var(--bg-muted); color: var(--fg-2); text-align: center; font-weight: 500;
}

/* pick-mode hover box */
.hi {
  position: fixed; pointer-events: none; display: none; border-radius: 4px;
  border: 1.5px solid var(--accent); background: var(--hl-soft);
  transition: all 50ms linear;
}
.hi .hl {
  position: absolute; left: -1.5px; bottom: calc(100% + 4px); max-width: 280px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; padding: 0 6px; border-radius: 4px;
  background: var(--accent); color: var(--on-accent); font: 500 11px/18px var(--font);
}
.hi.no-room-above .hl { bottom: auto; top: 2px; left: 2px; }

/* pins: the tip (bottom-left corner) sits on the spot */
.pin {
  --ring: 0 0 0 2px var(--bg);
  position: fixed; width: 22px; height: 22px; margin-top: -22px; pointer-events: auto;
  border-radius: 11px 11px 11px 3px; font: 600 11px/22px var(--font); text-align: center;
  font-variant-numeric: tabular-nums; color: var(--on-accent); background: var(--accent);
  box-shadow: var(--ring), var(--shadow-pin); cursor: pointer; user-select: none; transform-origin: 0 100%;
  animation: pin-in 220ms var(--ease) both; transition: box-shadow 160ms ease, transform 160ms var(--ease);
}
@keyframes pin-in { from { opacity: 0; transform: scale(0.8); } }
.pin:hover { transform: scale(1.08); }
.pin.read { background: var(--bg); color: var(--fg-1); border: 1px solid var(--line-strong); line-height: 20px; }
.pin.draft { background: var(--bg); color: var(--fg-muted); border: 1px dashed var(--fg-faint); line-height: 20px; }
.pin.resolved { background: var(--bg-muted); color: var(--fg-muted); border: 1px solid var(--line); line-height: 20px; }
.pin.deleted { background: var(--bg-muted); color: var(--fg-faint); border: 1px solid var(--line); line-height: 20px; text-decoration: line-through; }
.pin.detached { opacity: 0.7; }
.pin.on { box-shadow: var(--ring), 0 0 0 4px var(--accent), var(--shadow-pin); }
.pin.flash { animation: pin-flash 900ms var(--ease) 2; }
@keyframes pin-flash {
  0% { box-shadow: var(--ring), 0 0 0 2px var(--accent-line), var(--shadow-pin); }
  100% { box-shadow: var(--ring), 0 0 0 12px transparent, var(--shadow-pin); }
}
.layer.collapsed #pins { display: none; }

/* thread (panel row and popover share it) */
.th { position: relative; padding: 14px 20px; border-bottom: 1px solid var(--line); cursor: pointer; }
.th:hover { background: var(--bg-subtle); }
.th.open { cursor: default; background: color-mix(in oklab, var(--accent-soft) 55%, var(--bg)); box-shadow: inset 0 0 0 1px var(--accent-line); }
.th.open > .row[data-act] { cursor: pointer; }
.th:focus-visible { outline-offset: -2px; }
.row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.av {
  width: 24px; height: 24px; border-radius: 12px; flex: none; text-align: center;
  font: 600 10px/24px var(--font); color: oklch(100% 0 0); background: oklch(var(--av-l) 0.1 var(--h, 262));
}
.av.draft { background: var(--bg); color: var(--fg-muted); border: 1px dashed var(--fg-faint); line-height: 22px; }
.nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.th.read .nm { font-weight: 500; }
.tm { color: var(--fg-muted); font-size: 12px; white-space: nowrap; }
.num { margin-left: auto; font-size: 12px; color: var(--fg-muted); font-weight: 500; }
.dot { width: 8px; height: 8px; border-radius: 4px; background: var(--accent); flex: none; }
.bd { padding-left: 32px; }
.q { margin: 6px 0 4px; color: var(--fg-1); overflow-wrap: anywhere; }
.q span {
  background: var(--hl-soft); box-shadow: inset 0 -2px 0 var(--hl-line); border-radius: 2px;
  padding: 0 2px; -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
.th.open .q span { background: var(--hl); box-shadow: inset 0 -2px 0 var(--accent); }
.q .lost { color: var(--fg-muted); font-size: 12px; white-space: nowrap; }
.spot { display: flex; align-items: center; gap: 6px; margin: 6px 0 4px; color: var(--fg-muted); font-size: 12px; min-width: 0; }
.spot span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tx { color: var(--fg); white-space: pre-wrap; overflow-wrap: anywhere; }
.th.read .tx { color: var(--fg-1); }
.th:not(.open) .bd .tx { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.meta { margin-top: 6px; font-size: 12px; color: var(--fg-muted); display: flex; align-items: center; gap: 6px; }
.meta .btn { margin-left: auto; }
.meta .fresh { color: var(--accent-ink); font-weight: 600; }
.rp { margin-top: 12px; }
.rp .tx { margin-top: 2px; padding-left: 32px; }
.new { font-size: 11px; font-weight: 600; color: var(--accent-ink); background: var(--accent-tint); border-radius: 4px; padding: 0 6px; line-height: 18px; }
.tag { font-size: 11px; font-weight: 500; color: var(--fg-2); border: 1px dashed var(--fg-faint); border-radius: 4px; padding: 0 6px; line-height: 16px; white-space: nowrap; }
.tag.st { border-style: solid; border-color: var(--line); background: var(--bg-muted); }
.inp {
  margin: 12px 0 0 32px; display: flex; align-items: flex-end; gap: 4px; padding: 3px 3px 3px 11px;
  background: var(--bg); border: 1px solid var(--line-strong); border-radius: 8px;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.inp:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint); }
.inp textarea { min-height: 28px; max-height: 160px; padding: 4px 0; line-height: 20px; overflow-y: auto; }
.send {
  width: 28px; height: 28px; border-radius: 6px; display: grid; place-items: center; flex: none;
  background: var(--accent); color: var(--on-accent); pointer-events: auto; transition: background-color 120ms ease, opacity 120ms ease;
}
.send:disabled { background: var(--bg-muted); color: var(--fg-faint); cursor: default; }
.acts { margin: 10px 0 0 32px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.acts .push { margin-left: auto; }
.confirm { margin: 10px 0 0 32px; padding: 8px 8px 8px 12px; display: flex; align-items: center; gap: 6px; border-radius: 8px; background: var(--danger-soft); }
.confirm span { flex: 1; font-size: 12px; color: var(--fg-1); }
.tools {
  position: absolute; top: 10px; right: 14px; display: none; gap: 2px; padding: 2px;
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow-pop);
}
.tools .ib { width: 28px; height: 28px; }
@media (hover: hover) {
  .th:not(.open):hover .tools, .th:not(.open):focus-within .tools { display: flex; }
}

/* panel */
.panel {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(var(--panel-w), 100vw); pointer-events: auto;
  display: flex; flex-direction: column; background: var(--bg); border-left: 1px solid var(--line);
  box-shadow: var(--shadow-panel); transform: translateX(100%); visibility: hidden;
  transition: transform 220ms var(--ease), visibility 0s 220ms;
}
.panel.open { transform: none; visibility: visible; transition: transform 220ms var(--ease), visibility 0s; }
.hd { display: flex; align-items: center; gap: 8px; height: 52px; padding: 12px 12px 0 20px; flex: none; }
.hd h2 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; line-height: 20px; }
.site { font-size: 12px; color: var(--fg-muted); background: var(--bg-muted); border-radius: 4px; padding: 0 6px; line-height: 20px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hd .ib:first-of-type { margin-left: auto; }
.act { display: flex; align-items: center; gap: 12px; padding: 12px 20px 14px; flex: none; }
.hint { font-size: 12px; color: var(--fg-muted); }
.tabs { display: flex; gap: 20px; padding: 0 20px; border-bottom: 1px solid var(--line); flex: none; }
.tab {
  height: 40px; display: flex; align-items: center; gap: 6px; font-weight: 500; color: var(--fg-muted);
  border-bottom: 2px solid transparent; margin-bottom: -1px; pointer-events: auto; transition: color 120ms ease;
}
.tab:hover { color: var(--fg); }
.tab.on { color: var(--fg); border-color: var(--fg); }
.tab.on .n { background: var(--fg); color: var(--bg); }
.flt { display: flex; align-items: center; gap: 6px; padding: 10px 20px; border-bottom: 1px solid var(--line); flex: none; }
.chip {
  height: 28px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border-radius: 14px;
  font-weight: 500; font-size: 12px; color: var(--fg-2); border: 1px solid var(--line); pointer-events: auto;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
.chip:hover { background: var(--bg-subtle); color: var(--fg); }
.chip.on { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent-ink); }
.chip.on .n { background: var(--accent); color: var(--on-accent); }
.stat {
  margin-left: auto; display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 6px 0 8px;
  border-radius: 6px; font-size: 12px; font-weight: 500; color: var(--fg-muted); pointer-events: auto;
}
.stat:hover { background: var(--bg-muted); color: var(--fg); }
.stat.on { background: var(--accent-soft); color: var(--accent-ink); }
.list { flex: 1; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.grp {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; height: 32px; width: 100%;
  padding: 0 20px; font-size: 12px; font-weight: 500; color: var(--fg-2); background: var(--bg-subtle);
  border-bottom: 1px solid var(--line);
}
.grp span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hidden-unread {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 10px 20px;
  font-size: 12px; color: var(--fg-muted); text-align: left; pointer-events: auto;
  transition: background-color 120ms ease, color 120ms ease;
}
.hidden-unread:hover { background: var(--bg-subtle); color: var(--fg); }
.hidden-unread .i { margin-left: auto; }
.empty { padding: 56px 32px; text-align: center; color: var(--fg-muted); font-size: 12px; }
.empty .i { width: 20px; height: 20px; }
.empty .ring { width: 40px; height: 40px; border-radius: 20px; background: var(--bg-muted); display: grid; place-items: center; margin: 0 auto 12px; color: var(--fg-muted); }
.empty strong { display: block; color: var(--fg); font-size: 13px; font-weight: 600; margin-bottom: 2px; }

/* popover: compose, and a thread when the panel is closed */
.pop {
  position: fixed; pointer-events: auto; width: 360px; max-height: min(520px, calc(100vh - 16px));
  overflow-y: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  box-shadow: var(--shadow-pop); display: none; opacity: 0; transform: scale(0.97);
  transform-origin: var(--po, top left); transition: opacity 140ms ease-out, transform 160ms var(--ease);
}
.pop.show { display: block; }
.pop.in { opacity: 1; transform: none; }
.pop .th { border: 0; padding: 14px 14px 12px; cursor: default; background: none; box-shadow: none; }
.pop .th > .row { cursor: default; }
.pop .inp, .pop .acts, .pop .confirm { margin-left: 32px; }
.pop .acts { gap: 4px; }
.compose { padding: 12px; }
.ctx { color: var(--fg-muted); font-size: 12px; margin-bottom: 8px; overflow-wrap: anywhere; }
.compose .q { margin: 0 0 8px; }
.field { border: 1px solid var(--line-strong); border-radius: 8px; padding: 7px 10px; transition: border-color 120ms ease, box-shadow 120ms ease; }
.field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint); }
.field textarea { min-height: 60px; max-height: 180px; display: block; overflow-y: auto; }
.bar { display: flex; gap: 6px; justify-content: flex-end; align-items: center; margin-top: 10px; }
.bar .note { margin-right: auto; font-size: 12px; color: var(--fg-muted); }
.pop.shake { animation: pop-shake 320ms var(--ease); }
@keyframes pop-shake { 20% { translate: -6px 0; } 40% { translate: 5px 0; } 60% { translate: -3px 0; } 80% { translate: 2px 0; } }

/* floating toolbar, and the bubble it minimizes into */
.fab {
  position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 2px; padding: 4px;
  background: var(--bg); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow-pop);
  pointer-events: auto; transform-origin: calc(100% - 20px) center;
  transition: transform 240ms var(--ease), opacity 160ms ease-out, visibility 0s;
}
.layer.collapsed .fab, .layer.panel-open .fab {
  opacity: 0; transform: scale(0.6); visibility: hidden; pointer-events: none;
  transition: transform 240ms var(--ease), opacity 160ms ease-out, visibility 0s 240ms;
}
.fab .sep { width: 1px; height: 18px; background: var(--line); margin: 0 2px; }
.badge {
  position: absolute; top: 2px; right: 2px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: var(--accent); color: var(--on-accent); font: 600 10px/16px var(--font); text-align: center;
  box-shadow: 0 0 0 2px var(--bg);
}
.nub {
  position: fixed; right: 16px; bottom: 16px; width: 42px; height: 42px; border-radius: 21px;
  display: grid; place-items: center; background: var(--bg); color: var(--fg-1); border: 1px solid var(--line);
  box-shadow: var(--shadow-pop); font: 600 13px/1 var(--font); pointer-events: none;
  opacity: 0; transform: scale(0.6); visibility: hidden;
  transition: transform 240ms var(--ease), opacity 160ms ease-out, visibility 0s 240ms;
}
.nub.has { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.layer.collapsed .nub { opacity: 1; transform: none; visibility: visible; pointer-events: auto; transition: transform 240ms var(--ease), opacity 160ms ease-out, visibility 0s; }
.layer.collapsed .nub:active { transform: scale(0.96); }

/* menu: right-click on the toolbar, the panel's More button, the status picker */
.menu {
  position: fixed; min-width: 232px; padding: 4px; pointer-events: auto; background: var(--bg);
  border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow-pop); display: none;
  opacity: 0; transform: scale(0.97); transform-origin: var(--mo, top right); z-index: 6;
  transition: opacity 120ms ease-out, transform 140ms var(--ease);
}
.menu.show { display: block; }
.menu.in { opacity: 1; transform: none; }
.mhead { color: var(--fg-muted); font-size: 12px; padding: 6px 8px 8px; border-bottom: 1px solid var(--line); margin-bottom: 4px; white-space: nowrap; }
.mi {
  display: flex; width: 100%; align-items: center; gap: 8px; height: 32px; padding: 0 8px; border-radius: 6px;
  color: var(--fg-1); text-align: left; white-space: nowrap;
}
.mi:hover { background: var(--bg-muted); color: var(--fg); }
.mi .k { margin-left: auto; color: var(--fg-muted); font-size: 12px; }
.mi.on { color: var(--accent-ink); }
.mi.armed, .mi.armed:hover { color: var(--danger); background: var(--danger-soft); }
.msep { height: 1px; background: var(--line); margin: 4px 0; }

.toast {
  position: fixed; left: 0; right: 0; bottom: 24px; margin: 0 auto; width: max-content; max-width: calc(100vw - 32px);
  background: var(--fg); color: var(--bg); font-size: 13px; line-height: 18px; padding: 8px 12px;
  border-radius: 8px; box-shadow: var(--shadow-pop); pointer-events: none; opacity: 0; transform: translateY(6px);
  transition: opacity 180ms ease-out, transform 180ms var(--ease);
}
.toast.show { opacity: 1; transform: none; }
.layer.docked .toast { right: var(--panel-w); }

@media (pointer: coarse) {
  .btn, .btn.sm, .chip, .stat, .mi { height: 40px; }
  .chip { border-radius: 20px; }
  .ib, .tools .ib, .send { width: 40px; height: 40px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::after { transition: none !important; animation: none !important; }
  .pop.shake { border-color: var(--danger); }
}
`;

/** ::highlight() only styles ranges in the tree that owns their nodes, so this
 *  sheet is adopted by the document, not the shadow root. A mid-lightness blue
 *  reads on light and dark host pages alike, so it ignores the OS scheme. */
export const HIGHLIGHT_CSS = `
::highlight(brisk-comment) {
  background-color: oklch(60% 0.17 262 / 0.14); text-decoration: underline 2px oklch(60% 0.17 262 / 0.6);
}
::highlight(brisk-comment-focus) {
  background-color: oklch(60% 0.17 262 / 0.28); text-decoration: underline 2px oklch(60% 0.17 262);
}`;
