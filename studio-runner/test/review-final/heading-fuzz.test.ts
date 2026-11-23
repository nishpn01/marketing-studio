/**
 * Final-diff review (3d3b75b..e9228dd): differential fuzz of the exclude_headings parser in director-session.ts cleaned().
 * Reference oracle errs toward OVER-excluding: everything between the excluded heading and the one unambiguous
 * top-level terminator ("\n\n## Public") is private, whatever constructs sit in between. Any sentinel that survives
 * is a failure; a fail-closed refusal is acceptable. Synthetic sentinels only.
 *
 * Tests marked { todo } reproduce open findings: they assert the SAFE behaviour and are expected to fail today.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bizWs } from '../adversarial/harness.ts';
import { sessionStart, evidenceAddCatalog, contextSync, contextSearch } from '../../src/director-session.ts';
import { editBiz } from '../adversarial/harness.ts';

const SENT = 'FINALREV-SENTINEL';
function cleanedOf(doc: string, exclude = ['## Private']): string {
  const w = bizWs([{ id: 'doc', path: '${DOCS}/doc.md', visibility: 'approved', description: 'doc', exclude_headings: exclude }], { 'doc.md': doc });
  sessionStart(w.ws, 'Probe the heading parser on one document.', 'probe-sess');
  try { const rec = evidenceAddCatalog(w.ws, 'probe-sess', 'doc'); return readFileSync(join(w.ws, rec.path), 'utf8'); }
  catch (e) { if (/matched no section|invalid exclude_headings/.test((e as Error).message)) return 'FAIL-CLOSED'; throw e; }
}
const leaks = (out: string) => out !== 'FAIL-CLOSED' && out.includes(SENT);

// Private-section blocks. Each is self-contained; s is the block's sentinel. Heading-like lines here are NOT
// top-level headings in CommonMark (or are ambiguous), so the oracle says the section continues through them.
const BLOCKS: ((s: string) => string[])[] = [
  s => [`plain paragraph ${s}`],
  s => ['```bash', '# install step', `echo ${s}`, '```'],
  s => ['~~~', '## not a heading', s, '~~~'],
  s => ['````', '```', '# x', s, '```', '````'],
  s => ['   ```', '# indented-fence comment', s, '   ```   '],
  s => ['<!--', '# draft heading', s, '-->'],
  s => ['<!-- note', '## x', s, '-->'],
  s => ['<pre>', '# shell history', '', s, '</pre>'],
  s => ['<div>', '## inner', s, '</div>'],
  s => ['> ## quoted heading', `> ${s}`],
  s => ['> a quote', '---', s],
  s => ['- item', '  ## nested heading', `  ${s}`],
  s => ['    # indented code', `    ${s}`],
  s => ['\t# tab code', `\t${s}`],
  s => ['| a | b |', '|---|---|', `| ${s} | 2 |`],
  s => ['Sub heading', '-----------', s],
  s => ['---', s],
  s => [`Ünïcödé ŝtrïng ${s}`],
  s => ['# nbsp is not an ATX opener', s],
  s => ['#hashtag', s],
  s => ['\\## escaped', s],
  s => ['- item', '', '  ```', '  # c', `  ${s}`, '  ```'],
  s => ['> ```', '> # c', `> ${s}`, '> ```'],
];
const HEADS: string[][] = [['## Private'], ['## Private ##'], ['## **Private:**'], ['Private', '-------'], ['  ## Private']];

function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function docOf(picks: number[], head: string[], crlf: boolean) {
  const body = picks.flatMap((b, k) => [...BLOCKS[b](`${SENT}-${k}-${b}`), '']);
  return ['# Doc', '', 'Intro.', '', ...head, `first ${SENT}-head`, '', ...body, '', '## Public', 'public text', ''].join(crlf ? '\r\n' : '\n');
}
/** Index of the first block whose sentinel survives (that block ended the section), or -1. */
function firstLeak(out: string, picks: number[]) { if (out === 'FAIL-CLOSED') return -1; assert.ok(out.includes('public text'), 'public section kept'); return picks.findIndex((_, k) => out.includes(`${SENT}-${k}-`)); }
// Pre-existing at 3d3b75b (LF): <pre>, <div>, list-nested heading, NBSP after '#'.
const KNOWN_LF = new Set([7, 8, 11, 18]);

test('FUZZ-1: every construct alone, under every heading form (LF)', () => {
  const lf = new Set<number>();
  for (let b = 0; b < BLOCKS.length; b++) for (const head of HEADS) for (const crlf of [false, true]) {
    const out = cleanedOf(docOf([b], head, crlf));
    assert.ok(!out.includes(`${SENT}-head`) || out === 'FAIL-CLOSED', 'heading line itself excluded');
    if (!crlf && firstLeak(out, [b]) === 0) lf.add(b);
  }
  assert.deepEqual([...lf].filter(b => !KNOWN_LF.has(b)), [], 'no LF leak beyond the known pre-existing constructs');
});
test('FUZZ-1-CRLF: CRLF must not add leak classes', () => {
  const cr = new Set<number>();
  for (let b = 0; b < BLOCKS.length; b++) for (const head of HEADS) if (firstLeak(cleanedOf(docOf([b], head, true)), [b]) === 0) cr.add(b);
  assert.deepEqual([...cr].filter(b => !KNOWN_LF.has(b)), []);
});
test('FUZZ-2: 300 random sequences of 2-4 constructs (seeded), LF only, first-leak attribution', () => {
  const r = rng(20261111); const causes = new Set<number>();
  for (let it = 0; it < 300; it++) {
    const picks = Array.from({ length: 2 + Math.floor(r() * 3) }, () => Math.floor(r() * BLOCKS.length));
    const k = firstLeak(cleanedOf(docOf(picks, HEADS[Math.floor(r() * HEADS.length)], false)), picks);
    if (k >= 0) causes.add(picks[k]);
  }
  assert.deepEqual([...causes].filter(b => !KNOWN_LF.has(b)), [], 'sequences introduce no new leak class');
});

// ---- Regression introduced by this diff (passes at 3d3b75b): fence regex `(.*)$` cannot match a trailing \r ----
test('FINAL-R1 (BLOCKER, regression): CRLF document, fenced code with "# comment" inside the private section', () => {
  const doc = ['# Doc', '', '## Private', '```bash', '# install', `token ${SENT}`, '```', '', '## Public', 'end', ''].join('\r\n');
  assert.ok(!leaks(cleanedOf(doc)));
});
test('FINAL-R1b (regression): U+2028 after a fence info string also defeats the fence regex', () => {
  assert.ok(!leaks(cleanedOf(`# Doc\n\n## Private\n\`\`\`js \n# c\n${SENT}\n\`\`\`\n\n## Public\nend\n`)));
});

// ---- Regressions introduced by this diff: a construct that hides a REAL duplicate heading, while another copy matches ----
test('FINAL-R2 (regression): inline "<!--" mid-line opens a scanner comment and hides a later real "## Private"', () => {
  const doc = `# Doc\n\n## Private\nA\n\n## Public\nUse \`<!--\` to open a comment.\n\n## Private\n${SENT}\n\n## Other\nclose --> here\n`;
  assert.ok(!leaks(cleanedOf(doc)));
});
test('FINAL-R3 (regression): a setext heading over a paragraph line starting with "<" is not recognised, so a second "Private" setext section survives', () => {
  const doc = `# Doc\n\n## Private\nA\n\n## Public\n<3 love it\nPrivate\n-------\n${SENT}\n\n## End\nend\n`;
  // Either excluded or withheld by the post-check is safe; leaking is not.
  let out: string | null = null; try { out = cleanedOf(doc); } catch (e) { assert.match((e as Error).message, /withheld/); }
  if (out !== null) assert.ok(!leaks(out));
});

// ---- Pre-existing (also leak at 3d3b75b), contradict "ambiguous constructs keep excluding" ----
test('FINAL-P1 (pre-existing): ATX-looking line inside an HTML block (<pre>, <div>) ends the section', () => {
  assert.ok(!leaks(cleanedOf(`# Doc\n\n## Private\n<pre>\n# shell\n\n${SENT}\n</pre>\n\n## Public\nend\n`)));
  assert.ok(!leaks(cleanedOf(`# Doc\n\n## Private\n<div>\n## Inner\n${SENT}\n</div>\n\n## Public\nend\n`)));
});
test('FINAL-P2 (pre-existing): a heading nested in a list item ends the section', () => {
  assert.ok(!leaks(cleanedOf(`# Doc\n\n## Private\n- item\n  ## Sub\n  ${SENT}\n\n## Public\nend\n`)));
});
test('FINAL-P3 (pre-existing): "#" followed by NBSP is treated as an ATX heading (CommonMark: paragraph)', () => {
  assert.ok(!leaks(cleanedOf(`# Doc\n\n## Private\n# x\n${SENT}\n\n## Public\nend\n`)));
});
test('FINAL-P4 (pre-existing): a backtick fence opener whose info string contains a backtick (not a fence) hides a real duplicate heading', () => {
  assert.ok(!leaks(cleanedOf(`# Doc\n\n## Private\nA\n\n## Public\n\`\`\` a\`b\n\n## Private\n${SENT}\n\n\`\`\`\n`)));
});

test('CONTROL: zero-match fails closed at evidence-add and context-sync, and context-search omits the doc (CRLF too)', () => {
  const doc = `# Doc\r\n\r\n## Privat\r\nzebrafinch ${SENT}\r\n`;
  const w = bizWs([{ id: 'doc', path: '${DOCS}/doc.md', visibility: 'approved', description: 'doc', exclude_headings: ['## Private'] }], { 'doc.md': doc });
  sessionStart(w.ws, 'Probe the fail-closed path on one document.', 'probe-sess');
  assert.throws(() => evidenceAddCatalog(w.ws, 'probe-sess', 'doc'), /matched no section/);
  editBiz(w.ws, b => { b.context_sync = [{ from: '${DOCS}/doc.md', to: 'context/doc.md' }]; });
  assert.throws(() => contextSync(w.ws), /matched no section/);
  assert.ok(!JSON.stringify(contextSearch(w.ws, 'zebrafinch')).includes(SENT));
});

test('FINAL-R4 (regression, low): setext walk-back is quadratic in paragraph length (comment claims linear time)', () => {
  const t = Date.now(); cleanedOf('# Doc\n\n## Private\n' + 'a\n-\n'.repeat(16000) + '\n## Public\nend\n');
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t} ms for a 64 KB document (200 KB cap allows ~10x that)`);
});
