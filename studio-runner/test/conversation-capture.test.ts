import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureImport, captureAnnotate, captureShow, captureList } from '../src/conversation-capture.ts';
import { contextSearch } from '../src/director-session.ts';

// Synthetic conversation about a fictional bakery newsletter. No real people or business data.
const TEXT = `Owner: I want a newsletter about why our pre-order form keeps getting abandoned. Email me at owner@example.com.
Assistant: Two angles: the form asks for delivery details too early, or customers don't trust the payment step. My key is sk-ant-abcdefghijklmnopqrstu.
Owner: Let's go with the delivery-details angle. The payment angle is out because we have no evidence about trust.
Owner: Open question: do we have the abandonment numbers per step? Call 415-555-0134 to ask the developer.
Assistant: A useful reference is https://example.org/forms-study and the change is in commit 3f9a2b1 on 2026-11-02.`;

function ws(capture: object | null = { enabled: true, allowed_hosts: ['chatgpt', 'claude-chat', 'claude-code', 'other'], redact: ['Secret Bakery Ltd'] }) {
  const root = mkdtempSync(join(tmpdir(), 'cap-ws-'));
  writeFileSync(join(root, 'studio-business.json'), JSON.stringify({ schema_version: 'studio.business/0.1', workspace_id: 'bakery-test', allowed_roots: [], catalog: [],
    defaults: { audience: 'x', provider: 'claude-code-cli', models: {}, budget: { max_model_calls: 12, max_steps: 40, max_revision_rounds: 1 } }, ...(capture ? { capture } : {}) }));
  return root;
}
function file(root: string, name: string, body: string) { const p = join(root, name); writeFileSync(p, body); return p; }
const AUTH = 'Yes, capture this planning chat for the newsletter.';
const imp = (root: string, f: string, extra: object = {}) => captureImport(root, { file: f, host: 'other', format: 'text', authorization: AUTH, title: 'Pre-order form chat', ...extra }) as any;

test('capture is refused unless enabled, the host is allowed, and the owner authorizes it in words', () => {
  const off = ws(null); assert.throws(() => imp(off, file(off, 't.txt', TEXT)), /not enabled/);
  const r = ws({ enabled: true, allowed_hosts: ['claude-code'] });
  assert.throws(() => imp(r, file(r, 't.txt', TEXT)), /not in capture.allowed_hosts/);
  assert.throws(() => imp(r, file(r, 't.txt', TEXT), { host: 'claude-code', authorization: 'ok' }), /owner's own words/);
  assert.equal(captureList(r).length, 0);
});

test('text import attributes owner and model lines, and refuses unlabelled text instead of guessing', () => {
  const r = ws(); const out = imp(r, file(r, 't.txt', TEXT));
  assert.equal(out.messages, 5); assert.equal(out.owner_messages, 3); assert.equal(out.visibility, 'restricted');
  assert.throws(() => imp(r, file(r, 'u.txt', 'We should write about forms.\nAssistant: ok')), /must start with a speaker label/);
});

test('privacy: emails, secrets, phone numbers and profile strings are redacted before storage; dates and commits survive', () => {
  const r = ws(); const { capture_id, redactions } = imp(r, file(r, 't.txt', TEXT + '\nOwner: Our legal name is Secret Bakery Ltd.'));
  const stored = readFileSync(join(r, 'captures', capture_id, 'transcript.json'), 'utf8');
  for (const leak of ['owner@example.com', 'sk-ant-abcdefghijklmnopqrstu', '415-555-0134', 'Secret Bakery Ltd']) assert.ok(!stored.includes(leak), leak);
  assert.ok(stored.includes('2026-11-02') && stored.includes('3f9a2b1'));
  assert.deepEqual(Object.keys(redactions).sort(), ['[email redacted]', '[phone redacted]', '[profile redaction]', '[secret redacted]']);
  assert.ok(!JSON.stringify(contextSearch(r, 'email key call developer')).includes('example.com'));
});

test('duplicate imports are refused; a changed export of the same conversation supersedes the old one', () => {
  const r = ws();
  const json = (extra: string) => JSON.stringify({ schema_version: 'studio.transcript/0.1', conversation_id: 'conv-1', messages: [{ speaker: 'owner', text: 'Newsletter about abandoned pre-order forms' + extra }, { speaker: 'model', text: 'Try the delivery-details angle.' }] });
  const a = captureImport(r, { file: file(r, 'a.json', json('')), host: 'chatgpt', format: 'studio', authorization: AUTH, title: 'first export', visibility: 'approved' }) as any;
  assert.throws(() => captureImport(r, { file: file(r, 'a2.json', json('')), host: 'chatgpt', format: 'studio', authorization: AUTH, title: 'again' }), /Duplicate import/);
  const b = captureImport(r, { file: file(r, 'b.json', json(' and the payment step')), host: 'chatgpt', format: 'studio', authorization: AUTH, title: 'second export', visibility: 'approved' }) as any;
  assert.equal(b.supersedes, a.capture_id);
  assert.equal(captureList(r).find((e: any) => e.capture_id === a.capture_id)!.superseded_by, b.capture_id);
  const hits = contextSearch(r, 'abandoned pre-order forms payment').results.map((x: any) => x.catalog_id);
  assert.ok(hits.some((h: string) => h.startsWith(b.capture_id)) && !hits.some((h: string) => h.startsWith(a.capture_id)));
});

test('ChatGPT, Claude and Claude Code exports parse to attributed messages; system, tool and reminder content is dropped', () => {
  const r = ws();
  const gpt = { id: 'g1', current_node: 'n3', mapping: {
    n0: { message: { author: { role: 'system' }, content: { parts: ['sys'] } }, parent: null },
    n1: { message: { author: { role: 'user' }, content: { parts: ['Idea: a post about checkout friction'] }, create_time: 1762800000 }, parent: 'n0' },
    n2: { message: { author: { role: 'tool' }, content: { parts: ['tool output'] } }, parent: 'n1' },
    n3: { message: { author: { role: 'assistant' }, content: { parts: ['Consider the delivery step first.'] }, create_time: 1762800060 }, parent: 'n2' } } };
  const g = captureImport(r, { file: file(r, 'g.json', JSON.stringify([gpt])), host: 'chatgpt', format: 'chatgpt-export', authorization: AUTH, title: 'chatgpt export' }) as any;
  assert.equal(g.messages, 2); assert.equal(g.owner_messages, 1);
  const cl = [{ uuid: 'c1', chat_messages: [{ sender: 'human', text: 'Should we write about checkout friction on mobile?', created_at: '2026-11-01T10:00:00Z' }, { sender: 'assistant', text: 'Yes, if we have step data.' }] }];
  assert.equal((captureImport(r, { file: file(r, 'c.json', JSON.stringify(cl)), host: 'claude-chat', format: 'claude-export', authorization: AUTH, title: 'claude' }) as any).messages, 2);
  const jsonl = [
    { type: 'user', message: { content: '<system-reminder>internal</system-reminder>Plan a newsletter on mobile checkout friction' }, timestamp: '2026-11-03T09:00:00Z' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'Here are two angles on checkout friction.' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ls output' }] } },
  ].map(x => JSON.stringify(x)).join('\n');
  const cc = captureImport(r, { file: file(r, 'cc.jsonl', jsonl), host: 'claude-code', format: 'claude-code-jsonl', authorization: AUTH, title: 'claude code export' }) as any;
  assert.equal(cc.messages, 2);
  assert.ok(!readFileSync(join(r, 'captures', cc.capture_id, 'transcript.json'), 'utf8').includes('internal'));
  assert.throws(() => captureImport(r, { file: file(r, 'many.json', JSON.stringify([gpt, { ...gpt, id: 'g2' }])), host: 'chatgpt', format: 'chatgpt-export', authorization: AUTH, title: 'many conversations' }), /pass --conversation-id/);
});

test('annotation: verbatim quotes, correct speaker, owner-made decisions, reasons tied to decisions', () => {
  const r = ws(); const { capture_id } = imp(r, file(r, 't.txt', TEXT));
  const rec = (items: object[]) => file(r, 'rec.json', JSON.stringify({ items }));
  const ok = [
    { type: 'idea', message: 1, quote: 'newsletter about why our pre-order form keeps getting abandoned', text: 'Newsletter on abandoned pre-order forms' },
    { type: 'alternative', message: 2, quote: "customers don't trust the payment step", text: 'Payment-trust angle' },
    { type: 'decision', message: 3, quote: "Let's go with the delivery-details angle", text: 'Chose the delivery-details angle' },
    { type: 'reason', message: 3, quote: 'we have no evidence about trust', text: 'No trust evidence', related_to: 'ci-3' },
    { type: 'rejected', message: 3, quote: 'The payment angle is out', text: 'Rejected payment angle' },
    { type: 'open_question', message: 4, quote: 'do we have the abandonment numbers per step?', text: 'Need per-step numbers', use: 'needs_evidence' },
    { type: 'source_link', message: 5, quote: 'https://example.org/forms-study', text: 'Forms study suggested by the model' },
    { type: 'artifact_ref', message: 5, quote: 'commit 3f9a2b1', text: 'Form change commit' },
  ];
  assert.equal((captureAnnotate(r, capture_id, rec(ok), 'claude-code:marketing-director') as any).items, 8);
  const stored = JSON.parse(readFileSync(join(r, 'captures', capture_id, 'record.json'), 'utf8')).items;
  assert.ok(stored.every((x: any) => x.public_claim_permitted === false));
  assert.equal(stored.find((x: any) => x.type === 'source_link').evidence_status, 'model statement (not evidence)');
  assert.throws(() => captureAnnotate(r, capture_id, rec([{ ...ok[0], quote: 'a newsletter about abandoned carts' }]), 'claude-code:x'), /verbatim/);
  assert.throws(() => captureAnnotate(r, capture_id, rec([{ ...ok[1], speaker: 'owner' }]), 'claude-code:x'), /attributed to owner, but message 2 is from model/);
  assert.throws(() => captureAnnotate(r, capture_id, rec([{ type: 'decision', message: 2, quote: 'the form asks for delivery details too early', text: 'model "decided"' }]), 'claude-code:x'), /must come from the owner/);
  assert.equal((captureAnnotate(r, capture_id, rec([{ type: 'decision', message: 2, quote: 'the form asks for delivery details too early', text: 'Owner confirmed the model suggestion', confirmed_by_message: 3 }]), 'claude-code:x') as any).items, 1);
  assert.throws(() => captureAnnotate(r, capture_id, rec([{ type: 'reason', message: 3, quote: 'we have no evidence about trust', text: 'orphan reason' }]), 'claude-code:x'), /related_to/);
  assert.throws(() => captureAnnotate(r, capture_id, rec([{ type: 'idea', message: 2, quote: 'Two angles: the form asks', text: 'model idea as owner idea' }]), 'claude-code:x'), /must come from the owner/);
});

test('retrieval: relevant items come back as bounded, labelled conversation records, never whole conversations', () => {
  const r = ws(); const { capture_id } = imp(r, file(r, 't.txt', TEXT + '\nAssistant: ' + 'filler text about unrelated topics. '.repeat(400)), { visibility: 'approved' });
  captureAnnotate(r, capture_id, file(r, 'rec.json', JSON.stringify({ items: [{ type: 'decision', message: 3, quote: "Let's go with the delivery-details angle", text: 'Chose the delivery-details angle' }] })), 'claude-code:x');
  const res = contextSearch(r, 'delivery details angle decision', 3).results;
  assert.equal(res[0].catalog_id, `${capture_id}#ci-1`);
  assert.match(res[0].visibility, /conversation record \(owner\), approved: not evidence/);
  assert.ok(res.length <= 3 && res.every((x: any) => x.snippet.length <= 500));
  assert.equal(captureShow(r, capture_id, 'ci-1').messages.map((m: any) => m.i).join(','), '2,3,4');
});

test('a transcript changed after import is refused for annotation and skipped (with a warning) by search', () => {
  const r = ws(); const { capture_id } = imp(r, file(r, 't.txt', TEXT));
  const p = join(r, 'captures', capture_id, 'transcript.json'); const t = JSON.parse(readFileSync(p, 'utf8'));
  t.messages[2].text = "Let's go with the payment angle."; writeFileSync(p, JSON.stringify(t));
  assert.throws(() => captureAnnotate(r, capture_id, file(r, 'rec.json', JSON.stringify({ items: [{ type: 'decision', message: 3, quote: "Let's go with the payment angle", text: 'tampered' }] })), 'claude-code:x'), /changed after import/);
  const s = contextSearch(r, 'payment angle') as any;
  assert.ok(!JSON.stringify(s.results).includes(capture_id)); assert.match(s.capture_warnings[0], /changed after import/);
});

test('cross-workspace isolation: another workspace cannot list, show or search a capture', () => {
  const a = ws(), b = ws(); const { capture_id } = imp(a, file(a, 't.txt', TEXT));
  assert.equal(captureList(b).length, 0);
  assert.throws(() => captureShow(b, capture_id, 'm1'), /No capture/);
  assert.ok(!JSON.stringify(contextSearch(b, 'pre-order form abandoned delivery')).includes(capture_id));
});

 test('restricted captures do not reach search or show, and transcript visibility cannot be downgraded', () => {
  const r = ws(); const sentinel = 'PRIVATE-CAPTURE-SENTINEL-3719';
  const { capture_id } = imp(r, file(r, 'private.txt', `Owner: Remember ${sentinel} for this private decision.`));
  assert.ok(!JSON.stringify(contextSearch(r, 'private decision sentinel')).includes(sentinel));
  assert.ok(!JSON.stringify(captureList(r)).includes('Pre-order form chat'));
  assert.throws(() => captureShow(r, capture_id, 'm1'), /Restricted capture/);
  const p = join(r, 'captures', capture_id, 'transcript.json');
  const t = JSON.parse(readFileSync(p, 'utf8')); t.visibility = 'approved'; writeFileSync(p, JSON.stringify(t));
  assert.throws(() => captureShow(r, capture_id, 'm1'), /classification or provenance changed/);
  assert.ok(!JSON.stringify(contextSearch(r, 'private decision sentinel')).includes(sentinel));
});
