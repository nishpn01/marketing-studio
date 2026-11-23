/**
 * Opus final review: the hand-written exclude_headings parser in director-session.ts cleaned(), compared with
 * CommonMark block semantics. A line the parser mistakes for a heading ends the excluded section early, so the
 * rest of the private section is kept. Synthetic sentinels only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bizWs, editBiz } from '../adversarial/harness.ts';
import { sessionStart, evidenceAddCatalog, contextSearch, contextSync } from '../../src/director-session.ts';

const SECRET = 'PRIVATE-TAIL-SENTINEL-4471';
/** Add one catalog doc with `## Private` excluded and return the cleaned evidence text. */
function cleanedOf(doc: string, exclude = ['## Private']): string {
  const w = bizWs([{ id: 'doc', path: '${DOCS}/doc.md', visibility: 'approved', description: 'doc', exclude_headings: exclude }], { 'doc.md': doc });
  sessionStart(w.ws, 'Probe the heading parser on one document.', 'probe-sess');
  const rec = evidenceAddCatalog(w.ws, 'probe-sess', 'doc');
  return readFileSync(join(w.ws, rec.path), 'utf8');
}
const wrap = (inner: string) => `# Doc\n\nIntro text.\n\n## Private\nFirst private line.\n${inner}\nThe tail mentions ${SECRET}.\n\n## Public\nPublic end.\n`;

test('OPUS-H1 (fixed): "> quote" followed by "---" (CommonMark: blockquote + thematic break) is parsed as a setext heading and ends the excluded section', () => {
  assert.ok(!cleanedOf(wrap('> a quoted line\n---')).includes(SECRET));
});
test('OPUS-H2 (fixed): 4-space / tab indented code followed by "---" is parsed as a setext heading', () => {
  assert.ok(!cleanedOf(wrap('\n    indented code line\n---')).includes(SECRET));
  assert.ok(!cleanedOf(wrap('\n\tindented code line\n---')).includes(SECRET));
});
test('OPUS-H3 (fixed): a list-item continuation line followed by "===" is parsed as a setext h1 and ends the excluded section', () => {
  assert.ok(!cleanedOf(wrap('- item\n  continued\n===')).includes(SECRET));
});
test('OPUS-H4 (fixed): a heading-like line inside an HTML comment ends the excluded section (renderers hide it)', () => {
  assert.ok(!cleanedOf(wrap('<!--\n# old draft heading\n-->')).includes(SECRET));
});
test('OPUS-H5 (fixed): a fence "closer" with an info string closes the fence early, so "# comment" in code ends the section', () => {
  assert.ok(!cleanedOf(wrap('```\nx = 1\n```bash\n# install step\n```')).includes(SECRET));
});
test('OPUS-H6 (fixed): excluding a section and one of its own subsections works in either order', () => {
  for (const order of [['## Private', '### Salary'], ['### Salary', '## Private']]) {
    const t = cleanedOf('# Doc\n\n## Private\nA\n\n### Salary\nB\n\n## Public\nC\n', order);
    assert.ok(!t.includes('\nA\n') && !t.includes('\nB\n') && t.includes('C'));
  }
});

test('CONTROL: CRLF, closing #s, emphasis/colon, nested and tilde fences, # comments in fences, 4-space "# x", setext private heading', () => {
  const docs = [
    wrap('').replace(/\n/g, '\r\n'),
    wrap('').replace('## Private', '## **Private:** ##'),
    wrap('````\n```\n# not a heading\n```\n````'),
    wrap('~~~\n# not a heading\n~~~'),
    wrap('    # indented, not a heading'),
    wrap('').replace('## Private\n', 'Private\n-------\n'),
    wrap('| a | b |\n|---|---|\n| 1 | 2 |'),
    wrap('Some text\n\n---\n\nmore'),
  ];
  for (const d of docs) { const out = cleanedOf(d); assert.ok(!out.includes(SECRET), JSON.stringify(d)); assert.ok(out.includes('Public end')); }
});

test('CONTROL: unmatched exclusion fails closed at evidence-add and context-sync; context-search silently omits the document (no error, no warning)', () => {
  const w = bizWs([{ id: 'doc', path: '${DOCS}/doc.md', visibility: 'approved', description: 'doc', exclude_headings: ['## Renamed away'] }], { 'doc.md': `# Doc\n\n## Private\nzebrafinch ${SECRET}\n` });
  sessionStart(w.ws, 'Probe the fail-closed path on one document.', 'probe-sess');
  assert.throws(() => evidenceAddCatalog(w.ws, 'probe-sess', 'doc'), (e: Error) => /matched no section/.test(e.message) && !e.message.includes(SECRET));
  editBiz(w.ws, b => { b.context_sync = [{ from: '${DOCS}/doc.md', to: 'context/doc.md' }]; });
  assert.throws(() => contextSync(w.ws), /matched no section/);
  const r = contextSearch(w.ws, 'zebrafinch');
  assert.ok(!JSON.stringify(r).includes(SECRET));
  assert.ok(!JSON.stringify(r).includes('matched no section'), 'no warning reaches the context-search caller (doc says "with a generic error")');
  void writeFileSync;
});
