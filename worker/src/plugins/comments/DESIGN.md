---
name: Brisk Comments
description: The review layer Brisk injects on every site for signed-in teammates — toolbar, pins, popovers, docked panel.
colors:
  surface: 'oklch(100% 0 0)'
  surface-subtle: 'oklch(98.5% 0.002 265)'
  surface-muted: 'oklch(96.7% 0.003 265)'
  hairline: 'oklch(92.8% 0.006 265)'
  hairline-strong: 'oklch(87.2% 0.009 265)'
  ink-faint: 'oklch(70.7% 0.019 265)'
  ink-muted: 'oklch(55.1% 0.023 265)'
  ink-2: 'oklch(44.6% 0.026 265)'
  ink-1: 'oklch(37.3% 0.031 265)'
  ink: 'oklch(21% 0.032 265)'
  brisk-blue: 'oklch(46% 0.19 262)'
  brisk-blue-hover: 'oklch(41% 0.19 262)'
  brisk-blue-ink: 'oklch(42% 0.18 262)'
  brisk-blue-soft: 'oklch(97% 0.016 262)'
  brisk-blue-tint: 'oklch(93% 0.035 262)'
  brisk-blue-line: 'oklch(88% 0.06 262)'
  on-accent: 'oklch(100% 0 0)'
  danger: 'oklch(51% 0.19 27)'
  danger-soft: 'oklch(96.5% 0.02 27)'
  host-highlight: 'oklch(60% 0.17 262 / 0.14)'
  host-highlight-focus: 'oklch(60% 0.17 262 / 0.28)'
  surface-dark: 'oklch(18.5% 0.004 265)'
  hairline-dark: 'oklch(28.5% 0.006 265)'
  ink-dark: 'oklch(95% 0.005 265)'
  brisk-blue-dark: 'oklch(72% 0.13 262)'
  on-accent-dark: 'oklch(17% 0.03 262)'
typography:
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: '15px'
    fontWeight: 600
    lineHeight: '20px'
    letterSpacing: '-0.01em'
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: '13px'
    fontWeight: 400
    lineHeight: '20px'
    fontFeature: 'tnum'
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: '12px'
    fontWeight: 500
    lineHeight: '16px'
  micro:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: '11px'
    fontWeight: 600
    lineHeight: '18px'
rounded:
  xs: '2px'
  sm: '4px'
  md: '6px'
  lg: '8px'
  toolbar: '10px'
  pill: '14px'
spacing:
  xs: '4px'
  sm: '6px'
  md: '12px'
  row: '14px'
  gutter: '20px'
  indent: '32px'
components:
  button:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink-1}'
    rounded: '{rounded.md}'
    padding: '0 12px'
    height: '32px'
  button-hover:
    backgroundColor: '{colors.surface-subtle}'
    textColor: '{colors.ink}'
  button-primary:
    backgroundColor: '{colors.brisk-blue}'
    textColor: '{colors.on-accent}'
    rounded: '{rounded.md}'
    padding: '0 12px'
    height: '32px'
  button-primary-hover:
    backgroundColor: '{colors.brisk-blue-hover}'
  button-ghost:
    textColor: '{colors.ink-muted}'
    rounded: '{rounded.md}'
    height: '32px'
  button-sm:
    padding: '0 10px'
    height: '28px'
  icon-button:
    textColor: '{colors.ink-muted}'
    rounded: '{rounded.md}'
    size: '32px'
  chip:
    textColor: '{colors.ink-2}'
    rounded: '{rounded.pill}'
    padding: '0 10px'
    height: '28px'
  chip-on:
    backgroundColor: '{colors.brisk-blue-soft}'
    textColor: '{colors.brisk-blue-ink}'
  reply-input:
    backgroundColor: '{colors.surface}'
    rounded: '{rounded.lg}'
    padding: '3px 3px 3px 11px'
  popover:
    backgroundColor: '{colors.surface}'
    rounded: '{rounded.lg}'
    width: '360px'
  panel:
    backgroundColor: '{colors.surface}'
    width: '400px'
  pin:
    backgroundColor: '{colors.brisk-blue}'
    textColor: '{colors.on-accent}'
    typography: '{typography.micro}'
    size: '22px'
  avatar:
    textColor: '{colors.on-accent}'
    rounded: '12px'
    size: '24px'
---

# Design System: Brisk Comments

Scope: the comments widget only (`worker/src/plugins/comments`). The Brisk dashboard in `worker/assets` is a different world; this file does not describe it, and the dashboard's monospace / warm-paper language does not apply here.

## Overview

**Creative North Star: "The Quiet Margin"**

The widget is a review layer laid over someone else's page, so it reads as a clearly separate, calm sheet of neutral UI: the comments sidebar the category ships (Linear, Figma, Notion), executed at that craft level and no louder. White panel (near-black in dark mode), gray ink, hairline dividers, one blue. The host page stays the subject; the widget is the margin.

Density is tool-grade: 13px body, 32px controls, 20px gutters, threads that clamp to three lines until opened. Themed costumes were offered and rejected by the owner, and so were carets and connector lines between pins and threads. Future edits stay inside this restraint.

**Key Characteristics:**

- System font stack only; no web fonts, no monospace.
- Neutral cool grays (hue 265) plus one Brisk blue.
- Hairlines separate; soft shadows only lift floating layers.
- Docked side panel on wide screens, overlay on narrow ones.
- Light and dark for the widget chrome; host-page marks stay light.

## Colors

A near-achromatic cool-gray UI with a single saturated blue that always means "this needs you" or "this is the action".

### Primary

- **Brisk Blue** (`brisk-blue`): the unread signal (unread dots, unread pins, count badges, the toolbar bubble when there is unread), the primary action (Comment button, send, Publish), focus rings and input focus borders, and the quote highlight. Its soft/tint/line/ink derivatives carry selected states (active chip, `.on` icon buttons, "new" tags, the open thread's wash).

### Neutral

- **Surface / Subtle / Muted** (`surface`, `surface-subtle`, `surface-muted`): panel and popover ground, hover rows and sticky group headers, pressed/hover controls and count pills.
- **Hairline / Strong hairline** (`hairline`, `hairline-strong`): every divider and control border; input borders and read pins use the strong one.
- **Ink ramp** (`ink`, `ink-1`, `ink-2`, `ink-muted`, `ink-faint`): text from primary to placeholder; read threads drop from `ink` to `ink-1`.
- **Danger** (`danger`, `danger-soft`): delete confirmation only.

### Named Rules

**The One Blue Rule.** Blue is spent on unread state, the primary action, focus, and quotes. Nothing decorative is blue; a second hue never enters.

**The Host-Page Light Rule.** Pins and the pick box keep the light tokens whatever the OS scheme, because they sit on the teammate's page; only `:host` takes the dark block. Text highlights on the host page use a scheme-independent mid blue (`host-highlight`, `host-highlight-focus`, with a 2px underline at 0.6 / full alpha).

**The Hashed Avatar Rule.** Avatars are initials on a hue hashed from the author (`oklch(L 0.1 h)`, L 52% light / 48% dark), white text. This is the only place other hues appear, and it carries identity, not meaning.

## Typography

**Body Font:** system-ui (with -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif)

**Character:** One family, the reader's own OS face, so the widget feels native on any teammate's site. Tabular numerals throughout for counts and times.

### Hierarchy

- **Title** (600, 15px/20px, -0.01em): the panel heading "Comments" only.
- **Body** (400, 13px/20px): comment text, quotes, menu items, buttons (500).
- **Label** (500, 12px): times, meta lines, chips, tabs' counts, hints, group headers.
- **Micro** (600, 11px/18px): pin numbers, count pills (500), "new" and status tags.

### Named Rules

**The Native Face Rule.** The widget loads no fonts. Weight (400/500/600) and ink step carry hierarchy; no uppercase labels, no tracking-out.

## Layout

The panel is a fixed right column (400px, `min(400px, 100vw)`). At ≥900px it docks: the widget sets `margin-right: 400px !important` on `<html>` (restoring any prior inline value on close) so the page reflows beside it; below 900px it overlays. Toast and positioning math respect the docked width.

Panel stack, top to bottom: 52px header (title, site tag, More, close) → action row (Comment + hint) → 40px scope tabs with counts → filter row (Unread / Open chips, Resolved menu at the right) → scrolling list with 32px sticky group headers. Rows pad 14px 20px; thread body, quote, input and actions indent 32px to align under the name past the 24px avatar. Popovers are 360px wide, max 520px tall. The floating toolbar sits 16px from the bottom-right and collapses into a 42px round bubble.

Under `pointer: coarse` every control becomes a 40px target (buttons, chips, status, menu items, icon buttons, send); chips round to 20px. Hover-only row tools are gated by `hover: hover`.

## Elevation & Depth

Flat inside the panel: hairlines and tonal steps separate rows. Soft, ambient shadows lift only what floats over the host page.

### Shadow Vocabulary

- **Control** (`0 1px 2px` ink/6%): bordered buttons at rest.
- **Pop** (`0 1px 3px` ink/8%, `0 8px 24px` ink/12%): popovers, menus, toolbar, bubble, toast, row tools.
- **Pin** (`0 1px 2px` ink/20%, `0 2px 6px` ink/12%) behind a 2px surface ring.
- **Panel** (`-4px 0 16px` ink/5%): the panel's left edge.

### Named Rules

**The Float-Only Shadow Rule.** A shadow means "this floats over the page". Rows, tabs and cards inside the panel never get one; the open thread is marked by a blue wash and a 1px inset blue line instead.

## Shapes

Small, consistent radii: 6px on controls, 8px on popovers, menus, inputs and toast, 10px on the toolbar, pills for chips and counts, circles for avatars and the bubble. Quote highlights round 2px; tags and the site label 4px. The pin is a 22px teardrop (`11px 11px 11px 3px`) whose sharp bottom-left corner sits on the commented spot. Dashed borders mean "draft / not published" (draft pins, draft avatars, the Draft tag).

## Components

### Buttons

- **Shape:** gently rounded (6px), 32px tall, 28px small.
- **Default:** surface fill, hairline border, control shadow, `ink-1` text, 500 weight.
- **Primary:** Brisk Blue fill and border, white text; darker blue on hover. One per surface.
- **Ghost:** no border or shadow, muted ink; muted fill on hover. Used for quiet actions (Mark unread, Delete).
- **Danger:** red fill, only inside the delete confirmation.
- **Press:** `scale(0.97)` over 110ms with the house ease.

### Chips and Tabs

- **Tabs:** 40px, 500 weight, muted ink; active tab is full ink with a 2px ink underline and an inverted count pill.
- **Chips:** 28px pills with hairline border; on = blue soft fill, blue line border, blue ink text, solid blue count.

### Inputs

- **Reply input:** 8px radius, strong hairline, embedded 28px blue send button (muted when disabled). **Focus:** blue border plus a 3px blue-tint ring.
- **Compose field:** same treatment, 60–180px auto-height.

### Thread row

Avatar, name (600 unread / 500 read), time, `#n` thread number (matches its pin), 8px unread dot. Quote as a highlighted snippet (soft blue fill, 2px blue underline) or a target-icon spot line for element comments. Text clamps to 3 lines closed. Open: expands in place with replies, input, and Resolve / Mark unread / Delete.

### Pins

22px teardrops numbered in micro type. Unread: solid blue. Read: surface with strong hairline. Draft: dashed. Resolved/deleted: muted (deleted strikes through). Selected: 4px blue ring. Enter with a 220ms scale-in; flash twice to locate.

### Floating layers

Popover, menu (232px min, 32px items, `armed` destructive item turns red), toolbar, inverted toast and tooltip (ink fill, surface text, 400ms delay). All enter with opacity + `scale(0.97)` on `cubic-bezier(0.23, 1, 0.32, 1)` in 120–240ms; reduced motion removes all transitions.

### Icons

One drawn set: 16px grid, 1.5 stroke, round caps and joins, `currentColor`, inline SVG.

## Do's and Don'ts

### Do:

- **Do** use the system font stack and the existing ink ramp; add hierarchy with weight, not new sizes.
- **Do** spend Brisk Blue only on unread state, the primary action, focus and quotes.
- **Do** keep pins, the pick box and host highlights on the scheme-independent light tokens.
- **Do** give every new control a 40px target under `pointer: coarse` and gate hover-only UI behind `hover: hover`.
- **Do** reuse the 6px / 8px radii, 20px gutter and 32px body indent.

### Don't:

- **Don't** add web fonts, monospace, or any themed costume (neo-brutalist offset shadows, warm paper, retro chrome); the owner rejected them.
- **Don't** draw carets, arrows or connector lines between pins and threads or popovers; the owner rejected them.
- **Don't** put shadows on anything that does not float over the host page.
- **Don't** introduce a second accent hue or decorative blue.
- **Don't** borrow from the Brisk dashboard's visual language in `worker/assets`.
