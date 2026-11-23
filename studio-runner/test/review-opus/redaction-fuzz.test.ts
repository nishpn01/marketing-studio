/**
 * Opus final review: differential/property tests for redactAll (NFKD fold + map back to original offsets).
 * Reference: brute force over every substring of the OUTPUT; a substring whose case-folded form equals the
 * folded pattern is a leak. Synthetic strings only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactAll, fold } from '../../src/redact.ts';

/** Reference fold: same as fold() but applied per code point and with final sigma mapped to sigma (true case folding). */
const ref = (s: string) => [...s].map(c => fold(c)).join('').replace(/ς/g, 'σ').replace(/\s+/g, ' ');
const want = (p: string) => ref(p.trim()).trim();
function leaks(out: string, p: string): string[] {
  const w = want(p); if (!w) return [];
  const cps = [...out], hits: string[] = [];
  for (let a = 0; a < cps.length; a++) for (let b = a + 1; b <= Math.min(cps.length, a + 3 * w.length + 4); b++) {
    const s = cps.slice(a, b).join(''); if (s.includes('§')) break;
    if (ref(s) === w) hits.push(s);
  }
  return hits;
}
// Small PRNG so the fuzz is reproducible.
function rng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; }
const ALPHA = ['a', 'b', 'A', 'B', ' ', '\n', '\t', '\r\n', 'ﬁ', 'f', 'i', '́', 'é', 'é', '​', '­', 'Ａ', '㌀', 'ア', '😀', 'ǅ', 'Ⅻ', 'x'];
const pick = (r: () => number, xs: string[]) => xs[Math.floor(r() * xs.length)];

test('PROPERTY: for random text/pattern pairs (no Greek sigma), no fold-equal copy of the pattern survives', () => {
  const r = rng(7); let checked = 0;
  for (let n = 0; n < 20000; n++) {
    const p = Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(r, ALPHA)).join('');
    if (!want(p) || /[\n\t\r]/.test(p)) continue;
    // Plant the pattern, sometimes in a fold-equivalent spelling, among noise.
    const variant = r() < 0.5 ? p : p.toUpperCase().normalize(r() < 0.5 ? 'NFD' : 'NFKC');
    const text = Array.from({ length: 6 }, () => pick(r, ALPHA)).join('') + variant + Array.from({ length: 6 }, () => pick(r, ALPHA)).join('');
    const out = redactAll(text, [p], '§').text;
    assert.deepEqual(leaks(out, p), [], `text=${JSON.stringify(text)} p=${JSON.stringify(p)} out=${JSON.stringify(out)}`);
    checked++;
  }
  assert.ok(checked > 10000);
});

test('PROPERTY: text with no match is returned byte-identical; text outside matches is preserved in order', () => {
  const r = rng(11);
  for (let n = 0; n < 500; n++) {
    const text = Array.from({ length: 12 }, () => pick(r, ALPHA)).join('');
    assert.equal(redactAll(text, ['QZQZQ'], '[X]').text, text);
    const out = redactAll(`KEEP1 ${text} zz-target-zz ${text} KEEP2`, ['zz-target-zz'], '[X]').text;
    assert.equal(out, `KEEP1 ${text} [X] ${text} KEEP2`);
  }
});

test('CONTROL: expanding NFKD characters, ligatures, fullwidth, combining marks, astral code points, CRLF and tabs', () => {
  const cases: [string, string, string][] = [
    ['ﬁnance team', 'finance', '[X] team'], ['㌀ x', 'アパート', '[X] x'], ['Ａｃｍｅ inc', 'acme', '[X] inc'],
    ['😀Acme😀', 'acme', '😀[X]😀'], ['Zoë Müller', 'Zoë Müller', '[X]'], ['Jane\r\n\tDoe', 'jane doe', '[X]'],
    ['ab​cd', 'abcd', '[X]'], ['Ⅻ', 'xii', '[X]'], ['ǅemal', 'dzemal', '[X]'],
  ];
  for (const [t, p, o] of cases) assert.equal(redactAll(t, [p], '[X]').text, o, JSON.stringify([t, p]));
});

test('OPUS-R1 (fixed): an upper-case Greek word ending in Σ is redacted when the text equals the configured string', () => {
  // fold(pattern) lower-cases the whole string (final Σ -> ς); the text is folded one code point at a time (Σ -> σ).
  const name = 'ΑΝΝΑ ΠΑΠΑΔΟΠΟΥΛΟΣ';
  const r = redactAll(`Owner: ${name} signed.`, [name], '[X]');
  assert.equal(r.count, 1); assert.ok(!r.text.includes(name));
  assert.equal(redactAll('ΟΔΟΣ', ['ΟΔΟΣ'], '[X]').count, 1);
  // CONTROL: lower-case spellings match.
  assert.equal(redactAll('παπαδοπουλος', ['ΠΑΠΑΔΟΠΟΥΛΟΣ'], '[X]').count, 1);
});

test('LIMIT OPUS-R2: zero-width or Mongolian-vowel-separator used AS the word gap defeats a multi-word string; ß/ss are not equated', () => {
  assert.equal(redactAll('Jane​Doe', ['Jane Doe'], '[X]').count, 0);
  assert.equal(redactAll('Jane᠎Doe', ['Jane Doe'], '[X]').count, 0);
  assert.equal(redactAll('STRAUSS', ['Strauß'], '[X]').count, 0);
});

test('CONTROL: a trailing combining mark after a match is left outside the span (harmless dangling mark, no letters)', () => {
  assert.equal(redactAll('x Acmé y', ['acme'], '[X]').text, 'x [X]́ y');
});
