/** Owner-configured string redaction: case-, accent-, Unicode-form- and whitespace-tolerant; overlapping matches merged so no tail of a longer string survives. */
const STRIP = /[\p{M}\p{Cf}]/gu;
/** NFKD, drop combining marks and format characters (zero-width, soft hyphen), lower-case. */
/** Folded one code point at a time so context-dependent mappings (Greek final sigma) cannot make pattern and text disagree. */
export function fold(s: string): string { let o = ''; for (const c of s) o += c.normalize('NFKD').replace(STRIP, '').toLowerCase().replace(/ς/g, 'σ'); return o; }
export function redactAll(text: string, strings: string[], replacement: string): { text: string; count: number } {
  const list = [...new Set(strings.filter(s => typeof s === 'string' && fold(s).trim()).map(s => fold(s).trim()))];
  if (!list.length) return { text, count: 0 };
  // Folded copy of the text with a map from each folded char back to its original [start, end) range.
  let norm = ''; const from: number[] = [], to: number[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!, w = cp > 0xffff ? 2 : 1, f = fold(String.fromCodePoint(cp));
    for (let k = 0; k < f.length; k++) { from.push(i); to.push(i + w); }
    norm += f; i += w;
  }
  const spans: [number, number][] = [];
  for (const s of list) {
    const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'g');
    for (let m = rx.exec(norm); m; m = rx.exec(norm)) { if (m[0]) spans.push([from[m.index], to[m.index + m[0].length - 1]]); rx.lastIndex = m.index + 1; }
  }
  if (!spans.length) return { text, count: 0 };
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const sp of spans) { const last = merged.at(-1); if (last && sp[0] < last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([...sp]); }
  let out = '', at = 0;
  for (const [a, b] of merged) { out += text.slice(at, a) + replacement; at = b; }
  return { text: out + text.slice(at), count: merged.length };
}
