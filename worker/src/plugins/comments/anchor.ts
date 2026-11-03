export const QUOTE_MAX = 500;
export const CONTEXT_MAX = 32;
/** Raw text chars of one scope the widget will flatten; past this a quote is not searched. */
export const SCAN_MAX = 200_000;

/** The flat optional fields, in CLI positional order after `html`. */
export const ANCHOR_ARGS = ['quote', 'quotePrefix', 'quoteSuffix', 'point'] as const;
type AnchorArg = (typeof ANCHOR_ARGS)[number];

export type AnchorFields = { selector?: string } & { [K in AnchorArg]?: string };
export type RawAnchor = Readonly<Record<string, unknown>>;

/** Fractions of the element's box, each in [0, 1]. */
export interface Point {
  x: number;
  y: number;
}

/** Whitespace-normalized. `exact` is trimmed and non-empty; prefix/suffix are
 *  the ≤ CONTEXT_MAX chars beside it inside the scope element, possibly ''. */
export interface Quote {
  exact: string;
  prefix: string;
  suffix: string;
}

export type Anchor =
  | { kind: 'page' }
  | { kind: 'element'; selector: string; point: Point | null }
  | { kind: 'text'; selector: string; quote: Quote; point: Point | null };

export class AnchorError extends Error {}

const POINT_RE = /^(0(?:\.\d{1,4})?|1(?:\.0{1,4})?),(0(?:\.\d{1,4})?|1(?:\.0{1,4})?)$/;

/** Strict parse at the write boundary: normalizes, enforces caps and
 *  combinations, throws AnchorError naming the field. */
export function parseAnchor(raw: RawAnchor): Anchor {
  const str = (name: 'selector' | AnchorArg): string => {
    const v = raw[name];
    if (v === undefined) return '';
    if (typeof v !== 'string') throw new AnchorError(`${name} must be a string`);
    return v;
  };
  const selector = str('selector');
  const quote = str('quote');
  const prefix = normalizeText(str('quotePrefix'));
  const suffix = normalizeText(str('quoteSuffix'));
  const pointRaw = str('point');
  if (!selector) {
    if (quote || prefix || suffix || pointRaw)
      throw new AnchorError('quote and point need a selector');
    return { kind: 'page' };
  }
  let point: Point | null = null;
  if (pointRaw) {
    const m = POINT_RE.exec(pointRaw);
    if (!m) throw new AnchorError('point must be "x,y" fractions in [0,1], at most 4 decimals');
    point = { x: Number(m[1]), y: Number(m[2]) };
  }
  if (!quote) {
    if (prefix || suffix) throw new AnchorError('quotePrefix and quoteSuffix need a quote');
    return { kind: 'element', selector, point };
  }
  const exact = normalizeText(quote).trim();
  if (!exact) throw new AnchorError('quote is blank');
  if (exact.length > QUOTE_MAX) throw new AnchorError(`quote is over ${QUOTE_MAX} chars`);
  if (prefix.length > CONTEXT_MAX)
    throw new AnchorError(`quotePrefix is over ${CONTEXT_MAX} chars`);
  if (suffix.length > CONTEXT_MAX)
    throw new AnchorError(`quoteSuffix is over ${CONTEXT_MAX} chars`);
  return { kind: 'text', selector, quote: { exact, prefix, suffix }, point };
}

/** Total read of a stored doc or draft: a record parseAnchor rejects degrades
 *  to its selector alone. */
export function anchorOfRecord(rec: RawAnchor): Anchor {
  try {
    return parseAnchor(rec);
  } catch {
    return typeof rec.selector === 'string' && rec.selector
      ? { kind: 'element', selector: rec.selector, point: null }
      : { kind: 'page' };
  }
}

export function anchorFields(a: Anchor): AnchorFields {
  if (a.kind === 'page') return { selector: '' };
  const point = a.point ? { point: `${a.point.x.toFixed(4)},${a.point.y.toFixed(4)}` } : {};
  if (a.kind === 'element') return { selector: a.selector, ...point };
  return {
    selector: a.selector,
    quote: a.quote.exact,
    quotePrefix: a.quote.prefix,
    quoteSuffix: a.quote.suffix,
    ...point,
  };
}

/** Normalized concatenation of raw text chunks (one per DOM text node, in
 *  document order) with a two-way offset map. Whitespace runs (NBSP included)
 *  collapse to one space across chunk boundaries. */
export interface FlatText {
  text: string;
  toFlat(chunk: number, offset: number): number;
  /** Flat boundary → raw boundary. 'start' lands on the raw char of `flat`;
   *  'end' lands just past the raw char of `flat - 1`. */
  toRaw(flat: number, edge: 'start' | 'end'): { chunk: number; offset: number };
}

export function flatten(chunks: readonly string[]): FlatText {
  let text = '';
  let space = false;
  const rawToFlat: Int32Array[] = [];
  const srcChunk: number[] = [];
  const srcOffset: number[] = [];
  chunks.forEach((chunk, k) => {
    const map = new Int32Array(chunk.length + 1);
    for (let o = 0; o < chunk.length; o++) {
      map[o] = text.length;
      const c = chunk[o]!;
      const isSpace = /\s/.test(c);
      if (isSpace && space) continue;
      space = isSpace;
      text += isSpace ? ' ' : c;
      srcChunk.push(k);
      srcOffset.push(o);
    }
    map[chunk.length] = text.length;
    rawToFlat.push(map);
  });
  return {
    text,
    toFlat: (chunk, offset) => rawToFlat[chunk]![offset]!,
    toRaw: (flat, edge) => {
      const i = edge === 'start' ? flat : flat - 1;
      return { chunk: srcChunk[i]!, offset: srcOffset[i]! + (edge === 'start' ? 0 : 1) };
    },
  };
}

export const normalizeText = (s: string): string => flatten([s]).text;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function contextBefore(text: string, i: number): string {
  let s = Math.max(0, i - CONTEXT_MAX);
  if (s > 0 && isLow(text.charCodeAt(s))) s++;
  return text.slice(s, i);
}
function contextAfter(text: string, j: number): string {
  let e = Math.min(text.length, j + CONTEXT_MAX);
  if (e < text.length && isHigh(text.charCodeAt(e - 1))) e--;
  return text.slice(j, e);
}

/** A Quote from a flat span the user selected: capped at QUOTE_MAX, then
 *  trimmed, with context taken from the final edges. null when blank. */
export function captureQuote(text: string, start: number, end: number): Quote | null {
  while (start < end && text[start] === ' ') start++;
  if (end - start > QUOTE_MAX) {
    end = start + QUOTE_MAX;
    if (isHigh(text.charCodeAt(end - 1))) end--;
  }
  while (end > start && text[end - 1] === ' ') end--;
  if (start === end) return null;
  return {
    exact: text.slice(start, end),
    prefix: contextBefore(text, start),
    suffix: contextAfter(text, end),
  };
}

const commonSuffixLen = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
const commonPrefixLen = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/** Exact match on the quote; context picks between repeats, ties go to the
 *  earliest. No fuzzy matching: null means the words are gone. */
export function locateQuote(text: string, q: Quote): { start: number; end: number } | null {
  const len = q.exact.length;
  const perfect = q.prefix.length + q.suffix.length + 2;
  let best: { start: number; end: number } | null = null;
  let bestScore = -1;
  for (let i = text.indexOf(q.exact); i !== -1; i = text.indexOf(q.exact, i + 1)) {
    const before = contextBefore(text, i);
    const after = contextAfter(text, i + len);
    const exactContextBonus = (before === q.prefix ? 1 : 0) + (after === q.suffix ? 1 : 0);
    const score =
      commonSuffixLen(before, q.prefix) + commonPrefixLen(after, q.suffix) + exactContextBonus;
    if (score > bestScore) {
      best = { start: i, end: i + len };
      bestScore = score;
      if (score === perfect) break;
    }
  }
  return best;
}

export function anchorLines(a: Anchor): string[] {
  if (a.kind === 'page') return [];
  const lines = [`- selector: \`${a.selector}\``];
  if (a.kind === 'text') {
    lines.push(`- quote: ${JSON.stringify(a.quote.exact)}`);
    if (a.quote.prefix) lines.push(`- before: ${JSON.stringify(a.quote.prefix)}`);
    if (a.quote.suffix) lines.push(`- after: ${JSON.stringify(a.quote.suffix)}`);
  } else if (a.point) {
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    lines.push(`- spot: ${pct(a.point.x)} from left, ${pct(a.point.y)} from top of the element`);
  }
  return lines;
}
