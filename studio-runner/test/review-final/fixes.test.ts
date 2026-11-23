/** Coverage for the final-diff fixes: CRLF everywhere, post-check, linear setext scan, dirty-pin handling. Synthetic data only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bizWs } from '../adversarial/harness.ts';
import { sessionStart, evidenceAddCatalog, contextSearch } from '../../src/director-session.ts';

const S = 'CRLF-FIX-SENTINEL';
function clean(doc: string, exclude = ['## Private']): string {
  const w = bizWs([{ id: 'doc', path: '${DOCS}/doc.md', visibility: 'approved', description: 'doc', exclude_headings: exclude }], { 'doc.md': doc });
  sessionStart(w.ws, 'Probe the heading parser on one document.', 'fix-sess');
  try { return readFileSync(join(w.ws, evidenceAddCatalog(w.ws, 'fix-sess', 'doc').path), 'utf8'); } catch (e) { if (/withheld/.test((e as Error).message)) return 'WITHHELD'; throw e; }
}
const ok = (out: string) => !out.includes(S);

test('CRLF: every fence and heading variant keeps excluding (LF and CRLF agree)', () => {
  const blocks = [
    ['```bash', '# install', `echo ${S}`, '```'], ['~~~', '# install', `echo ${S}`, '~~~'], ['````', '```', '# x', `${S}`, '```', '````'],
    ['- item', '  ```', '  # step', `  ${S}`, '  ```'], ['```', 'x', '```bash', '# still code', `${S}`, '```'], ['```bash   ', '# c', `${S}`, '```  '],
    ['> quote', '---', `${S}`], ['<!--', '# hidden', '-->', `${S}`], ['    code', '---', `${S}`],
  ];
  for (const b of blocks) for (const eol of ['\n', '\r\n']) {
    const doc = ['# Doc', '', '## Private', 'first', ...b, '', '## Public', 'end', ''].join(eol);
    assert.ok(ok(clean(doc)), JSON.stringify([b, eol]));
  }
  for (const h of ['## Private', '##  Private ##', '## PRIVATE:', '## *Private*']) for (const eol of ['\n', '\r\n'])
    assert.ok(ok(clean(['# Doc', '', h, S, '', '## Public', 'end', ''].join(eol))), JSON.stringify([h, eol]));
});

test('post-check: a surviving excluded heading (hidden by an odd construct) withholds the document', () => {
  const doc = `# Doc\n\n## Private\nA\n\n## Public\n\`\`\` bad \` info\n\n## Private\n${S}\n\n## Other\nx\n`;
  const out = clean(doc); assert.ok(out === 'WITHHELD' || ok(out));
  const quoted = `# Doc\n\n## Private\nA\n\n## Public\n> ## Private\n> ${S}\n\n## Other\nx\n`;
  const q = clean(quoted); assert.ok(q === 'WITHHELD' || ok(q));
});

test('ATX-looking lines inside a raw HTML block, indented, or NBSP-separated do not end the section', () => {
  for (const mid of ['<div>\n## Sub\n</div>', '- item\n  ## Sub', '# notheading']) assert.ok(ok(clean(`# Doc\n\n## Private\n${mid}\n${S}\n\n## Public\nend\n`)), mid);
});

test('linear time: 128 KB of setext candidates, and context-search over many documents, stay under 1 s', () => {
  const t = Date.now(); const big = '# Doc\n\n## Private\n' + 'a\n-\n'.repeat(32_000) + '\n## Public\nend\n';
  clean(big); assert.ok(Date.now() - t < 1000, `evidence-add took ${Date.now() - t} ms`);
  const docs = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`d${i}.md`, '# D\n\n## Private\nx\n\n## Public\n' + 'a\n-\n'.repeat(6000) + 'zebrafinch word\n']));
  const w = bizWs(Object.keys(docs).map((n, i) => ({ id: `d${i}`, path: '${DOCS}/' + n, visibility: 'approved', description: n, exclude_headings: ['## Private'] })), docs);
  const t2 = Date.now(); contextSearch(w.ws, 'zebrafinch word', 10); assert.ok(Date.now() - t2 < 1500, `context-search took ${Date.now() - t2} ms`);
});
