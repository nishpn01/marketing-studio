/**
 * Independent review: redaction, heading exclusion and regex cost. Synthetic sentinels only.
 * "REPRO" tests assert the CURRENT (weak) behaviour so the suite stays green; when a finding is fixed the matching test
 * should start failing and be inverted. "CONTROL" tests confirm a defence that holds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { redactAll } from '../../src/redact.ts';
import { contextSearch, evidenceAddCatalog, sessionStart, loadSession } from '../../src/director-session.ts';
import { captureImport, redactEmails, redactObfuscatedEmails } from '../../src/conversation-capture.ts';
import { bizWs, put } from '../adversarial/harness.ts';

const SEC = 'zebra-quokka-7731-reviewsecret';
const planDoc = (heading: string) => `# Plan\n\nPublic intro paragraph about reminders.\n\n${heading}\n${SEC} confidential pricing body.\n\n## After\nClosing words.\n`;
function ws(doc: string) {
  const b = bizWs([{ id: 'plan', path: '${DOCS}/plan.md', visibility: 'approved', description: 'plan', exclude_headings: ['## Private'] }], { 'plan.md': doc });
  return b;
}
const search = (w: string) => JSON.stringify(contextSearch(w, 'confidential pricing body', 20).results);

test('CONTROL: an exact "## Private" section is excluded from context-search', () => {
  const b = ws(planDoc('## Private'));
  assert.ok(!search(b.ws).includes(SEC));
});

for (const [name, heading] of [
  ['renamed heading ("Private notes")', '## Private notes'],
  ['different level ("###")', '### Private'],
] as const) {
  test(`F-REDACT-1 (fixed): ${name} matches nothing, so the document is withheld everywhere (fail closed)`, () => {
    const b = ws(planDoc(heading));
    assert.ok(!search(b.ws).includes(SEC), 'unmatched exclusion must not leak through context-search');
    sessionStart(b.ws, 'A review idea long enough to pass', 'review-sess');
    assert.throws(() => evidenceAddCatalog(b.ws, 'review-sess', 'plan'), (e: Error) => /withheld/.test(e.message) && !e.message.includes(SEC));
  });
}
for (const [name, heading] of [['trailing colon', '## Private:'], ['emphasis in heading', '## *Private*'], ['closing hashes and case', '## PRIVATE ##']] as const) {
  test(`F-REDACT-1 (fixed): ${name} still matches and the section is excluded`, () => {
    const b = ws(planDoc(heading));
    assert.ok(!search(b.ws).includes(SEC));
  });
}

test('F-REDACT-1b (fixed): NFD heading in the document matches an NFC configuration', () => {
  const b = bizWs([{ id: 'plan', path: '${DOCS}/plan.md', visibility: 'approved', description: 'plan', exclude_headings: ['## Café private'] }], { 'plan.md': planDoc('## Cafe\u0301 private') });
  assert.ok(!search(b.ws).includes(SEC));
});
import { readFileSync } from 'node:fs';
const require_read = (p: string) => readFileSync(p, 'utf8');

test('F-REDACT-3 (fixed): redactAll folds NFD, zero-width, fullwidth and soft hyphen spellings', () => {
  const r = (text: string, s: string) => redactAll(text, [s], '[x]').count;
  assert.equal(r('Zoe\u0308 Mu\u0308ller', 'Zoë Müller'), 1, 'NFD text vs NFC config');
  assert.equal(r('Au\u200brora Falcon', 'Aurora Falcon'), 1, 'zero-width space inside');
  assert.equal(r('Au\u00adrora Falcon', 'Aurora Falcon'), 1, 'soft hyphen inside');
  assert.equal(r('\uff21urora Falcon', 'Aurora Falcon'), 1, 'fullwidth letter');
  assert.equal(r('aurora  FALCON', 'Aurora Falcon'), 1);
  assert.equal(redactAll('see Aurora\u200b Falcon now', ['Aurora Falcon'], '[x]').text, 'see [x] now');
});

const timed = (f: () => unknown) => { const t = Date.now(); f(); return Date.now() - t; };
test('F-PERF-1/2 (fixed): email and obfuscated-email redaction are linear on 200 KB adversarial input', () => {
  for (const input of ['a'.repeat(200_000), 'a.'.repeat(100_000), 'a@'.repeat(100_000), 'a dot '.repeat(35_000), 'a at a dot '.repeat(18_000), ('x'.repeat(60) + '@').repeat(3000)]) {
    const ms = timed(() => { redactEmails(input); redactObfuscatedEmails(input); });
    assert.ok(ms < 1000, `took ${ms}ms`);
  }
  assert.equal(redactEmails('mail jo.smith@example.org now').text, 'mail [email redacted] now');
  assert.equal(redactObfuscatedEmails('mail jo dot smith at example dot org now').text, 'mail [email redacted] now');
});
test('F-PERF-2 (fixed): captureImport of one 200k-char token finishes quickly', () => {
  const b = bizWs([], {}, { capture: { enabled: true, allowed_hosts: ['codex'], redact: [] } });
  const f = join(b.top, 't.txt'); writeFileSync(f, 'Owner: ' + 'a'.repeat(200_000) + '\nAssistant: ok fine\n');
  const ms = timed(() => captureImport(b.ws, { file: f, host: 'codex', format: 'text', authorization: 'Owner says import this one', title: 'perf probe' }));
  assert.ok(ms < 1500, `took ${ms}ms`);
});
test('F-PERF-3 (fixed): evidence-add with exclude_headings and 200 KB of adversarial heading lines is fast', () => {
  const doc = '# T\n\n# a' + ' '.repeat(100_000) + 'x\n' + ('## ' + ' '.repeat(40) + '#\n').repeat(1500) + '\n## Private\nbody\n';
  const b = ws(doc);
  sessionStart(b.ws, 'A review idea long enough to pass', 'perf-sess');
  const ms = timed(() => evidenceAddCatalog(b.ws, 'perf-sess', 'plan'));
  assert.ok(ms < 1500, `took ${ms}ms`);
});
