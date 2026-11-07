/** One drawn set: 16px grid, 1.5 stroke, round caps. */
const PATHS = {
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  chev: '<path d="M5 6.5l3 3 3-3"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  reopen: '<path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3"/><path d="M3.5 2.5v2.7h2.7"/>',
  target: '<circle cx="8" cy="8" r="4.5"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>',
  page: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  send: '<path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7"/>',
  unread:
    '<path d="M13 8.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3.5"/><circle cx="12" cy="4" r="1.8"/>',
  read: '<path d="M13 7.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5"/><path d="M6 7.5l2 2 5-5.5"/>',
  more: '<circle cx="4" cy="8" r=".75"/><circle cx="8" cy="8" r=".75"/><circle cx="12" cy="8" r=".75"/>',
  reply:
    '<path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5"/>',
  comment:
    '<path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5"/><path d="M8 5v4M6 7h4"/>',
  panel: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M9.5 3v10"/>',
  minimize: '<path d="M4 8h8"/>',
  eye: '<path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="1.75"/>',
  eyeOff:
    '<path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="1.75"/><path d="M3 13L13 3"/>',
  copy: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
  publish:
    '<path d="M8 10V2.5M5 5.5l3-3 3 3"/><path d="M3 9.5v2A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5v-2"/>',
  hide: '<path d="M2.5 8a5.5 5.5 0 1 0 11 0 5.5 5.5 0 1 0-11 0M4.2 11.8l7.6-7.6"/>',
  arrow: '<path d="M3.5 8h9M8.5 4l4 4-4 4"/>',
  smile:
    '<circle cx="8" cy="8" r="5.75"/><path d="M5.75 9.5a2.75 2.75 0 0 0 4.5 0"/><path d="M6.25 6.5v.25M9.75 6.5v.25"/>',
} as const;

export type IconName = keyof typeof PATHS;

export const icon = (name: IconName): string =>
  `<svg class="i" viewBox="0 0 16 16" aria-hidden="true">${PATHS[name]}</svg>`;
