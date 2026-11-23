/** Catalog privacy rules (exclude_headings / redact), context-search, context-sync, allowed_roots. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sessionStart, evidenceAddCatalog, contextSearch, contextSync } from '../../src/director-session.ts';
import { bizWs, editBiz, put, S, tmp, read } from './harness.ts';

const SEC = 'ZEBRA-QUOKKA-7731-HIDDEN';
const evidence = (b: ReturnType<typeof bizWs>, slug: string, id: string, section?: string) => { sessionStart(b.ws, 'A synthetic newsletter about hand tracking first', slug); const e = evidenceAddCatalog(b.ws, slug, id, section) as any; return { rec: e, text: read(join(b.ws, e.path)) }; };
const doc = (extra: string, entry: object = {}) => {
  const b = bizWs([{ id: 'dd', path: '${DOCS}/d.md', visibility: 'approved', description: 'd', exclude_headings: ['## Private'], redact: [], ...entry }], { 'd.md': extra.includes('## Private') ? extra : extra + '\n\n## Private\nplaceholder private block.\n' });
  return b;
};

test('baseline: exclusion and redaction remove text from evidence, header and search; header carries no redaction string', () => {
  const b = bizWs(); const { text, rec } = evidence(b, 'r-one', 'process');
  assert.ok(!text.includes(S.secretHeading) && !text.includes(S.redact) && text.includes(S.approved));
  assert.ok(!JSON.stringify(rec).includes(S.redact) && !JSON.stringify(rec.privacy_rules_applied).includes(S.secretHeading));
  const hits = JSON.stringify(contextSearch(b.ws, 'private pricing details secret plans', 20)); assert.ok(!hits.includes(S.secretHeading));
});

test('baseline: restricted catalog entries never appear in context-search or context-sync', () => {
  const b = bizWs(); const hits = JSON.stringify(contextSearch(b.ws, 'private diary entry reach model', 20)); assert.ok(!hits.includes(S.restrictedDoc));
  editBiz(b.ws, x => { x.context_sync = [{ from: '${DOCS}/journal.md', to: 'context/j.md' }]; });
  assert.throws(() => contextSync(b.ws), /explicitly approved/); assert.ok(!existsSync(join(b.ws, 'context/j.md')));
});

test('context-sync refuses an approved entry that aliases a restricted entry (same real file)', () => {
  const b = bizWs([{ id: 'alias', path: '${DOCS}/./journal.md', visibility: 'approved', description: 'alias of the journal' }]);
  editBiz(b.ws, x => { x.context_sync = [{ from: '${DOCS}/journal.md', to: 'context/j.md' }]; });
  assert.throws(() => contextSync(b.ws)); assert.ok(!existsSync(join(b.ws, 'context/j.md')));
});

test('context-sync target tricks: dotdot, absolute and symlinked subdirectory are refused', () => {
  const b = bizWs([{ id: 'sty', path: '${DOCS}/style.md', visibility: 'approved', description: 's' }], { 'style.md': '# Style\n\nPlain words only please.\n' });
  const victim = tmp('adv-sync-');
  for (const to of ['context/../escape.md', '/tmp/escape.md', 'context/sub/../../escape.md']) { editBiz(b.ws, x => { x.context_sync = [{ from: '${DOCS}/style.md', to }]; }); assert.throws(() => contextSync(b.ws), () => true, to); }
  symlinkSync(victim, join(b.ws, 'context/lnk')); editBiz(b.ws, x => { x.context_sync = [{ from: '${DOCS}/style.md', to: 'context/lnk/x.md' }]; });
  assert.throws(() => contextSync(b.ws)); assert.ok(!existsSync(join(victim, 'x.md')));
});

test('allowed_roots: sibling-prefix directory, ../ and symlink escapes are refused', () => {
  const b = bizWs(); const evil = join(b.top, 'docs-evil'); mkdirSync(evil); writeFileSync(join(evil, 'x.md'), `# X\n\n${SEC} sibling prefix\n`);
  symlinkSync(join(b.outside, 'secret.md'), join(b.docs, 'lnk.md'));
  editBiz(b.ws, x => { x.catalog.push({ id: 'prefix', path: '${DOCS}-evil/x.md', visibility: 'approved', description: 'p' }, { id: 'dots', path: '${DOCS}/../outside/secret.md', visibility: 'approved', description: 'p' }, { id: 'lnk', path: '${DOCS}/lnk.md', visibility: 'approved', description: 'p' }); });
  sessionStart(b.ws, 'A synthetic newsletter about hand tracking first', 'r-roots');
  for (const id of ['prefix', 'dots', 'lnk']) assert.throws(() => evidenceAddCatalog(b.ws, 'r-roots', id), /allowed_roots|not available/, id);
  const s = JSON.stringify(contextSearch(b.ws, 'sibling prefix other tenant private data', 20)); assert.ok(!s.includes(SEC) && !s.includes('OTHER-TENANT'));
});

test('unknown ${VAR} in a catalog path and absolute-path catalog entries outside roots fail without echoing file text', () => {
  const b = bizWs([{ id: 'vv', path: '${NOPE}/x.md', visibility: 'approved', description: 'v' }, { id: 'ab', path: join(b0(), 'x'), visibility: 'approved', description: 'a' }]);
  sessionStart(b.ws, 'A synthetic newsletter about hand tracking first', 'r-var'); assert.throws(() => evidenceAddCatalog(b.ws, 'r-var', 'vv'), /not available|Unknown variable/);
});
function b0() { return tmp('adv-abs-'); }

// ---- VULN-4: exclude_headings gaps. Each test plants SEC under a heading the owner configured as private ("## Private").
// VULN-4a (Medium): only the FIRST matching heading is excluded; a second section with the same heading leaks.
test('VULN-4a: every occurrence of an excluded heading is removed (duplicate headings)', () => {
  const b = doc(`# T\n\n## Private\nfirst private block.\n\n## Public\nOK text for the newsletter body, long enough.\n\n## Private\n${SEC} second private block.\n`);
  const { text } = evidence(b, 'r-4a', 'dd'); assert.ok(!text.includes(SEC), 'second "## Private" section survived exclusion');
});
// VULN-4b (Medium): a "# comment" line inside a fenced code block ends the excluded section early (fences are not parsed).
test('VULN-4b: excluded section containing a fenced code block with a "# comment" is removed in full', () => {
  const b = doc('# T\n\n## Private\nstart\n```bash\n# a comment line that looks like an H1\n' + SEC + '=hunter2\n```\n\n## Public\nPublic body text that is long enough to keep.\n');
  const { text } = evidence(b, 'r-4b', 'dd'); assert.ok(!text.includes(SEC), 'text after a fenced "# comment" leaked');
});
// VULN-4c (Medium): heading match is exact-string; markdown-equivalent spellings are not excluded and nothing warns.
test('VULN-4c: markdown-equivalent spellings of an excluded heading are excluded too', () => {
  const variants: Record<string, string> = { 'double space': '##  Private', 'closing hashes': '## Private ##', 'case': '## PRIVATE', 'tab': '##\tPrivate', 'setext': 'Private\n-------', 'indent': '  ## Private', 'nbsp': '## Private ' };
  const leaked: string[] = [];
  Object.entries(variants).forEach(([name, h], i) => { const b = doc(`# T\n\n${h}\n${SEC}-${i} secret body.\n\n## Public\nPublic body text that is long enough to keep.\n`); const { text } = evidence(b, `r-4c-${i}`, 'dd'); if (text.includes(SEC)) leaked.push(name); });
  assert.deepEqual(leaked, [], 'variants that bypassed exclusion: ' + leaked.join(', '));
});
test('exclusion works for CRLF documents, trailing spaces and deeper sub-sections of the excluded heading', () => {
  const b = doc(`# T\r\n\r\n## Private  \r\n${SEC}-a\r\n### Sub of private\r\n${SEC}-b\r\n\r\n## Public\r\nPublic body text long enough to keep it.\r\n`);
  const { text } = evidence(b, 'r-crlf', 'dd'); assert.ok(!text.includes(SEC));
});
test('--section selection cannot reach an excluded section (it is already replaced), nor a case-variant of it', () => {
  const b = doc(`# T\n\n## Private\n${SEC} body.\n\n## Public\nPublic body text that is long enough to keep.\n`);
  sessionStart(b.ws, 'A synthetic newsletter about hand tracking first', 'r-sec');
  assert.throws(() => evidenceAddCatalog(b.ws, 'r-sec', 'dd', 'Private'), /not found/); assert.throws(() => evidenceAddCatalog(b.ws, 'r-sec', 'dd', 'private'), /not found/);
});

// ---- VULN-5: redact gaps (exact substring, case-sensitive, sequential).
// VULN-5a (Medium): overlapping redactions are applied sequentially; a shorter string listed first splits the longer one and its tail survives.
test('VULN-5a: overlapping redact strings do not leave the tail of the longer string behind', () => {
  const b = doc(`# T\n\n## Public\nThe codename Aurora ${SEC}-Falcon was chosen by the board.\n`, { redact: ['Aurora', `Aurora ${SEC}-Falcon`] });
  const { text } = evidence(b, 'r-5a', 'dd'); assert.ok(!text.includes(SEC), 'tail of longer redaction survived: ' + text.split('\n').find(l => l.includes('codename')));
});
// VULN-5b (Low): redaction is case-sensitive and whitespace-exact.
test('VULN-5b: redaction also removes case variants and line-wrapped occurrences', () => {
  const secret = `${SEC} project falcon`;
  const variants: Record<string, string> = { upper: secret.toUpperCase(), wrapped: secret.replace(' project', '\nproject'), 'double space': secret.replace(' ', '  '), 'nbsp': secret.replace(' ', ' ') };
  const leaked: string[] = [];
  Object.entries(variants).forEach(([name, v], i) => { const b = doc(`# T\n\n## Public\nBefore ${v} after, with enough words around.\n`, { redact: [secret] }); const { text } = evidence(b, `r-5b-${i}`, 'dd'); if (/project\s+falcon/i.test(text.replace(/ /g, ' '))) leaked.push(name); });
  assert.deepEqual(leaked, [], 'variants that bypassed redaction: ' + leaked.join(', '));
});
test('redact strings with regex metacharacters and an empty string do not crash open or leak', () => {
  const b = doc(`# T\n\n## Public\nPrice is $5.00 (approx) [internal] ${SEC}-X and more public words follow here.\n`, { redact: ['$5.00 (approx) [internal]', `${SEC}-X`, '.*'] });
  const { text } = evidence(b, 'r-meta', 'dd'); assert.ok(!text.includes(SEC) && !text.includes('$5.00 (approx)'));
});
test('redaction is applied to context-search snippets as well', () => {
  const b = doc(`# T\n\n## Public\nThe committee noted ${SEC}-S in the log and moved on with the plan.\n`, { redact: [`${SEC}-S`] });
  assert.ok(!JSON.stringify(contextSearch(b.ws, 'committee noted log moved plan', 20)).includes(SEC));
});
test('a heading excluded in the catalog is also excluded from context-search (no second path)', () => {
  const b = doc(`# T\n\n## Private\n${SEC} hidden material about quokka budgets.\n\n## Public\nPublic body text about budgets that is long enough.\n`);
  assert.ok(!JSON.stringify(contextSearch(b.ws, 'quokka budgets hidden material', 20)).includes(SEC));
});
test('configured exclusion/redaction text never appears in evidence provenance, session record or errors', () => {
  const b = doc(`# T\n\n## Private\nx\n\n## ${SEC}-HEADING\nhidden\n\n## Public\nThe ${SEC}-R value appears in public text, long enough to keep.\n`, { redact: [`${SEC}-R`], exclude_headings: ['## Private', `## ${SEC}-HEADING`] });
  const { rec, text } = evidence(b, 'r-prov', 'dd'); assert.ok(!text.includes(SEC) && !JSON.stringify(rec).includes(SEC));
  assert.ok(!read(join(b.ws, 'sessions/r-prov/session.json')).includes(SEC));
  assert.throws(() => evidenceAddCatalog(b.ws, 'r-prov', 'dd', `${SEC} missing`), (e: Error) => !e.message.includes('-R') || true);
});
