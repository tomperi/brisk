import { describe, expect, it } from 'vitest';
import {
  AnchorError,
  CONTEXT_MAX,
  QUOTE_MAX,
  anchorFields,
  anchorLines,
  anchorOfRecord,
  captureQuote,
  flatten,
  locateQuote,
  normalizeText,
  parseAnchor,
  type Anchor,
} from '../src/plugins/comments/anchor';

const captureIn = (chunks: string[], words: string, from = 0) => {
  const { text } = flatten(chunks);
  const start = text.indexOf(words, from);
  return captureQuote(text, start, start + words.length)!;
};

describe('flatten', () => {
  it('collapses whitespace runs across node boundaries, NBSP included', () => {
    expect(flatten(['Hello\n', '  ', 'world']).text).toBe('Hello world');
    expect(flatten(['a  b', ' \t', '\nc']).text).toBe('a b c');
    expect(flatten(['billed ', ' monthly']).text).toBe('billed monthly');
  });

  it('reads text split across inline nodes as one string', () => {
    const flat = flatten(['Hello ', 'wor', 'ld']);
    expect(flat.text).toBe('Hello world');
    const hit = locateQuote(flat.text, { exact: 'world', prefix: 'Hello ', suffix: '' })!;
    expect(flat.toRaw(hit.start, 'start')).toEqual({ chunk: 1, offset: 0 });
    expect(flat.toRaw(hit.end, 'end')).toEqual({ chunk: 2, offset: 2 });
  });

  it('maps raw boundaries to flat offsets and back at node edges', () => {
    const flat = flatten(['ab  ', ' cd']);
    expect(flat.text).toBe('ab cd');
    expect(flat.toFlat(0, 0)).toBe(0);
    expect(flat.toFlat(0, 2)).toBe(2);
    expect(flat.toFlat(1, 1)).toBe(3);
    expect(flat.toFlat(1, 3)).toBe(5);
    expect(flat.toRaw(3, 'start')).toEqual({ chunk: 1, offset: 1 });
    expect(flat.toRaw(5, 'end')).toEqual({ chunk: 1, offset: 3 });
  });

  it('reads a line or block break between nodes as one space', () => {
    const flat = flatten(['Hello', 'world', ' again'], [false, true, true]);
    expect(flat.text).toBe('Hello world again');
    const hit = locateQuote(flat.text, { exact: 'world', prefix: 'Hello ', suffix: '' })!;
    expect(flat.toRaw(hit.start, 'start')).toEqual({ chunk: 1, offset: 0 });
    expect(flat.toRaw(hit.end, 'end')).toEqual({ chunk: 1, offset: 5 });
    expect(flat.toFlat(0, 5)).toBe(5);
    expect(flat.toFlat(1, 0)).toBe(6);
    expect(flatten(['a'], [true]).text).toBe('a');
  });

  it('keeps zero-width joiners, which are not whitespace', () => {
    expect(normalizeText('👩‍💻  ok')).toBe('👩‍💻 ok');
  });
});

describe('captureQuote', () => {
  it('trims the span and takes context from inside the scope', () => {
    const text = 'For small teams, pricing starts at $9 per seat — billed monthly.';
    const s = text.indexOf(' starts');
    expect(captureQuote(text, s, s + ' starts at $9 per seat '.length)).toEqual({
      exact: 'starts at $9 per seat',
      prefix: 'For small teams, pricing ',
      suffix: ' — billed monthly.',
    });
  });

  it('caps the quote at QUOTE_MAX without leaving a trailing space', () => {
    const text = `${'a'.repeat(QUOTE_MAX - 1)} tail`;
    const q = captureQuote(text, 0, text.length)!;
    expect(q.exact).toBe('a'.repeat(QUOTE_MAX - 1));
    expect(q.suffix).toBe(' tail');
    expect(locateQuote(text, q)).toEqual({ start: 0, end: QUOTE_MAX - 1 });
  });

  it('never splits a surrogate pair at the cap', () => {
    const text = `${'a'.repeat(QUOTE_MAX - 1)}😀b`;
    const q = captureQuote(text, 0, text.length)!;
    expect(q.exact).toBe('a'.repeat(QUOTE_MAX - 1));
    expect(q.suffix).toBe('😀b');
  });

  it('never splits a surrogate pair at a context edge', () => {
    const text = `😀${'x'.repeat(CONTEXT_MAX - 1)}QUOTE`;
    const q = captureIn([text], 'QUOTE');
    expect(q.prefix).toBe('x'.repeat(CONTEXT_MAX - 1));
  });

  it('returns null for a blank span', () => {
    expect(captureQuote('a   b', 1, 2)).toBeNull();
  });
});

describe('locateQuote', () => {
  const para = 'Plans: Pro is great. Team is great. Enterprise is great.';

  it('picks the repeated phrase the user selected, by context', () => {
    const second = para.indexOf('is great', para.indexOf('Team'));
    const q = captureQuote(para, second, second + 'is great'.length)!;
    expect(locateQuote(para, q)).toEqual({ start: second, end: second + 'is great'.length });
  });

  it('still finds the phrase when only its context was edited', () => {
    const q = captureIn([para], 'is great', para.indexOf('Team'));
    const edited = 'Plans: Pro is great. Teams are great. Team is great!';
    const hit = locateQuote(edited, q)!;
    expect(edited.slice(hit.start - 5, hit.end)).toBe('Team is great');
  });

  it('prefers the exact context window over an earlier one that only shares its start', () => {
    const pad = 'z'.repeat(40);
    const text = `${pad}END${pad}END`;
    const q = captureIn([text], 'END', 50);
    expect(q.suffix).toBe('');
    expect(locateQuote(text, q)).toEqual({ start: 83, end: 86 });
  });

  it('returns null once the quoted words were edited away', () => {
    const q = captureIn([para], 'Team is great');
    expect(locateQuote('Plans: Pro is great. Teams are great.', q)).toBeNull();
  });

  it('considers every occurrence, not only the first few hundred', () => {
    const text = `${'x '.repeat(400)}x UNIQUE`;
    const q = captureIn([text], 'x', text.length - 'x UNIQUE'.length);
    expect(locateQuote(text, q)).toEqual({ start: 800, end: 801 });
  });
});

describe('parseAnchor', () => {
  it('derives page, element and text anchors from the flat fields', () => {
    expect(parseAnchor({})).toEqual({ kind: 'page' });
    expect(parseAnchor({ selector: 'h1' })).toEqual({
      kind: 'element',
      selector: 'h1',
      point: null,
    });
    expect(parseAnchor({ selector: 'h1', point: '0.25,1' })).toEqual({
      kind: 'element',
      selector: 'h1',
      point: { x: 0.25, y: 1 },
    });
    expect(
      parseAnchor({ selector: 'p', quote: '  starts at $9   per\nseat ', quotePrefix: 'a  b' }),
    ).toEqual({
      kind: 'text',
      selector: 'p',
      quote: { exact: 'starts at $9 per seat', prefix: 'a b', suffix: '' },
      point: null,
    });
  });

  it.each([
    [{ quote: 'x' }, /selector/],
    [{ point: '0.5,0.5' }, /selector/],
    [{ selector: 'p', quotePrefix: 'x' }, /quote/],
    [{ selector: 'p', quote: '   ' }, /quote/],
    [{ selector: 'p', quote: 'a'.repeat(QUOTE_MAX + 1) }, /quote/],
    [{ selector: 'p', quote: 'x', quoteSuffix: 'b'.repeat(CONTEXT_MAX + 1) }, /quoteSuffix/],
    [{ selector: 'p', point: '1.5,0' }, /point/],
    [{ selector: 'p', point: '0.12345,0' }, /point/],
    [{ selector: 'p', point: '0.5' }, /point/],
    [{ selector: 'p', quote: 42 }, /quote/],
    [{ selector: ['p'] }, /selector/],
  ])('rejects %j', (raw, field) => {
    expect(() => parseAnchor(raw)).toThrow(AnchorError);
    expect(() => parseAnchor(raw)).toThrow(field);
  });

  it('accepts a quote whose raw form exceeds the cap but normalizes under it', () => {
    const raw = `${'a '.repeat(QUOTE_MAX / 2)}`.replace(/ /g, '   ');
    const a = parseAnchor({ selector: 'p', quote: raw });
    expect(a.kind === 'text' && a.quote.exact.length).toBe(QUOTE_MAX - 1);
  });

  it('round-trips through anchorFields', () => {
    const anchors: Anchor[] = [
      { kind: 'page' },
      { kind: 'element', selector: '#plans > p', point: null },
      { kind: 'element', selector: 'svg', point: { x: 0.8213, y: 0 } },
      {
        kind: 'text',
        selector: 'main > p:nth-of-type(2)',
        quote: { exact: 'per seat', prefix: 'at $9 ', suffix: ', billed' },
        point: { x: 1, y: 0.5 },
      },
      { kind: 'text', selector: 'p', quote: { exact: 'x', prefix: '', suffix: '' }, point: null },
    ];
    for (const a of anchors) expect(parseAnchor(anchorFields(a))).toEqual(a);
  });
});

describe('anchorOfRecord', () => {
  it('reads legacy records with no anchor fields', () => {
    expect(anchorOfRecord({ selector: 'h1', label: 'h1', text: 'x' })).toEqual({
      kind: 'element',
      selector: 'h1',
      point: null,
    });
    expect(anchorOfRecord({ selector: '', text: 'x' })).toEqual({ kind: 'page' });
    expect(anchorOfRecord({ text: 'x' })).toEqual({ kind: 'page' });
  });

  it('degrades a corrupt record to its selector instead of throwing', () => {
    expect(anchorOfRecord({ selector: 'p', point: 'nope', quote: 'x' })).toEqual({
      kind: 'element',
      selector: 'p',
      point: null,
    });
    expect(anchorOfRecord({ selector: 7, quote: 'x' })).toEqual({ kind: 'page' });
  });
});

describe('anchorLines', () => {
  it('prints the quote with its context, JSON-quoted', () => {
    const a = parseAnchor({
      selector: '#plans > p',
      quote: 'say "hi" \\ there',
      quotePrefix: 'For small teams, ',
      quoteSuffix: '',
      point: '0.5,0.5',
    });
    expect(anchorLines(a)).toEqual([
      '- selector: `#plans > p`',
      '- quote: "say \\"hi\\" \\\\ there"',
      '- before: "For small teams, "',
    ]);
  });

  it('prints the spot for an element anchor with a point', () => {
    expect(anchorLines(parseAnchor({ selector: 'svg', point: '0.8213,0.1199' }))).toEqual([
      '- selector: `svg`',
      '- spot: 82% from left, 12% from top of the element',
    ]);
    expect(anchorLines(parseAnchor({ selector: 'h1' }))).toEqual(['- selector: `h1`']);
    expect(anchorLines({ kind: 'page' })).toEqual([]);
  });
});
