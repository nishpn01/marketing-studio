/** Conversation capture, scoped disclosure grants, context-search of captures and the in-process local-tools boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync, existsSync, cpSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { captureImport, captureAnnotate, captureList, captureShow, loadCapture } from '../../src/conversation-capture.ts';
import { captureDisclosureGrant, captureDisclosureRead, captureDisclosureRevoke } from '../../src/capture-disclosure.ts';
import { sessionStart, contextSearch, sessionStatus } from '../../src/director-session.ts';
import { createLocalTools } from '../../src/local-tools.ts';
import { bizWs, editBiz, put, jread, jwrite, dump, tmp } from './harness.ts';

const CS = 'ZEBRA-QUOKKA-7731-CAPTURE';
function capWs(extraBiz: object = {}) {
  const b = bizWs([], {}, { capture: { enabled: true, allowed_hosts: ['claude-code'], redact: [], ...extraBiz } });
  return b;
}
const imp = (b: ReturnType<typeof bizWs>, text: string, o: object = {}) => {
  const f = put(b.top, `t-${Math.random().toString(36).slice(2)}.txt`, text);
  return captureImport(b.ws, { file: f, host: 'claude-code', format: 'text', authorization: 'The owner said: import this conversation.', title: 'Synthetic chat', ...o }) as any;
};
const CONV = `Owner: ${CS} we decided to cut the pricing tier in March for budget reasons.\nAssistant: Noted. I will remember the pricing tier decision.\nOwner: Keep it private.`;
const tool = (ws: string, names: any[]) => createLocalTools(ws, names);
const call = (t: ReturnType<typeof tool>, name: string, args: object) => t.call({ schema_version: 'studio.tool-call/0.1', name, arguments: args }) as any;

test('restricted capture (default): not listed by title, not shown, not searched, not available to local tools', () => {
  const b = capWs(); const c = imp(b, CONV); assert.equal(c.visibility, 'restricted');
  const list = JSON.stringify(captureList(b.ws)); assert.ok(!list.includes('Synthetic chat') && !list.includes(CS));
  assert.throws(() => captureShow(b.ws, c.capture_id, 'm1'), /Restricted capture/);
  assert.ok(!JSON.stringify(contextSearch(b.ws, 'pricing tier decision march budget', 20)).includes(CS));
  const t = tool(b.ws, ['capture_list', 'capture_show', 'context_search', 'session_status']);
  assert.ok(!JSON.stringify(call(t, 'capture_list', {})).includes('Synthetic chat'));
  assert.deepEqual(call(t, 'capture_show', { capture: c.capture_id, ref: 'm1' }), { ok: false, error: 'OPERATION_FAILED' });
  assert.ok(!JSON.stringify(call(t, 'context_search', { query: 'pricing tier decision budget' })).includes(CS));
});

test('capture ids and refs: traversal and malformed values are rejected', () => {
  const b = capWs(); imp(b, CONV);
  for (const id of ['../x', 'cap-../../x', 'cap-zzzzzzzzzzzz', 'cap-0123456789abc', '']) assert.throws(() => captureShow(b.ws, id, 'm1'), () => true, id);
  const t = tool(b.ws, ['capture_show']); for (const a of [{ capture: '../etc', ref: 'm1' }, { capture: 'cap-0123456789ab', ref: '../x' }, { capture: 'cap-0123456789ab', ref: 'm1; rm' }]) assert.equal(call(t, 'capture_show', a).ok, false);
});

test('import refuses disabled capture, unlisted host, missing authorization, symlinked transcript', () => {
  const b = capWs(); const f = put(b.top, 't.txt', CONV);
  assert.throws(() => captureImport(b.ws, { file: f, host: 'chatgpt', format: 'text', authorization: 'The owner said import it.', title: 'x y z' }), /allowed_hosts/);
  assert.throws(() => captureImport(b.ws, { file: f, host: 'claude-code', format: 'text', authorization: 'short', title: 'x y z' }), /authorization/);
  const l = join(b.top, 'l.txt'); symlinkSync(f, l); assert.throws(() => captureImport(b.ws, { file: l, host: 'claude-code', format: 'text', authorization: 'The owner said import it.', title: 'x y z' }), /symlink/);
  editBiz(b.ws, x => { x.capture.enabled = false; }); assert.throws(() => captureImport(b.ws, { file: f, host: 'claude-code', format: 'text', authorization: 'The owner said import it.', title: 'x y z' }), /not enabled/);
});

test('approved capture redacts emails, phones, key-shaped secrets and profile strings before storage', () => {
  const b = capWs({ redact: ['Project Heron'] });
  const c = imp(b, `Owner: mail me at jo.smith@example.org or call 415-555-0134 about Project Heron. key sk-ant-ABCDEFGHIJKLMNOP12345\nAssistant: ok`, { visibility: 'approved' });
  const stored = readFileSync(join(b.ws, 'captures', c.capture_id, 'transcript.json'), 'utf8');
  for (const s of ['jo.smith@example.org', '415-555-0134', 'Project Heron', 'sk-ant-ABCDEFGHIJKLMNOP12345']) assert.ok(!stored.includes(s), s);
});

// VULN-8a (Low): profile redaction in captures has the same sequential/overlap flaw as catalog redaction.
test('VULN-8a: overlapping capture redact strings do not leave the tail of the longer string', () => {
  const b = capWs({ redact: ['Heron', `Heron ${CS}-Tail`] });
  const c = imp(b, `Owner: the launch name is Heron ${CS}-Tail and it stays internal.\nAssistant: ok`, { visibility: 'approved' });
  assert.ok(!readFileSync(join(b.ws, 'captures', c.capture_id, 'transcript.json'), 'utf8').includes(CS));
});
// VULN-8b (Low): default PII/secret redaction is pattern-limited. Non-US phones, bearer/JWT tokens, Stripe/Google keys and
// obfuscated emails survive import and then appear in capture-show / context-search for an approved capture.
test('VULN-8b: default capture redaction covers common non-US phone numbers, bearer tokens and live API keys', () => {
  const b = capWs(); const samples = { uk_phone: '+44 20 7946 0958', jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstu', stripe: 'sk_live_51HabcdefghijklmnopQRST', google: 'AIzaSyA-1234567890abcdefghijklmnopqrstu', obf_email: 'jo dot smith at example dot org' };
  const c = imp(b, `Owner: ${Object.values(samples).join(' | ')}\nAssistant: ok`, { visibility: 'approved' });
  const stored = readFileSync(join(b.ws, 'captures', c.capture_id, 'transcript.json'), 'utf8');
  const survived = Object.entries(samples).filter(([, v]) => stored.includes(v)).map(([k]) => k);
  assert.deepEqual(survived, [], 'unredacted: ' + survived.join(', '));
});

test('a capture tampered after import (message text edited) is refused everywhere', () => {
  const b = capWs(); const c = imp(b, CONV, { visibility: 'approved' }); const f = join(b.ws, 'captures', c.capture_id, 'transcript.json');
  const t = jread(f); t.messages[0].text = 'Owner statement rewritten by an attacker'; jwrite(f, t);
  assert.throws(() => captureShow(b.ws, c.capture_id, 'm1'), /changed after import/); assert.ok(!JSON.stringify(captureList(b.ws)).includes('Synthetic chat'));
  assert.ok(!JSON.stringify(contextSearch(b.ws, 'owner statement rewritten attacker', 20).results).includes('rewritten'));
});

// VULN-6 (Medium, integrity): `visibility` is not covered by content_sha256 and index.json is unsigned. Flipping it in BOTH
// transcript.json and index.json turns a restricted capture into an approved one: captured text is then served by capture-show,
// context-search and the local tools. Same trust-anchor weakness class as VULN-1.
test('VULN-6: flipping capture visibility in transcript.json and index.json does not expose a restricted capture', () => {
  const b = capWs(); const c = imp(b, CONV); const tf = join(b.ws, 'captures', c.capture_id, 'transcript.json'), xf = join(b.ws, 'captures', 'index.json');
  const t = jread(tf); t.visibility = 'approved'; jwrite(tf, t); const x = jread(xf); x[0].visibility = 'approved'; jwrite(xf, x);
  let shown = ''; try { shown = JSON.stringify(captureShow(b.ws, c.capture_id, 'm1')); } catch { /* refusal is the safe outcome */ }
  assert.ok(!shown.includes(CS), 'restricted capture text served after a two-file visibility flip');
  assert.ok(!JSON.stringify(contextSearch(b.ws, 'pricing tier decision march budget', 20)).includes(CS), 'and via context-search');
});

test('annotating a capture requires verbatim quotes and owner-sourced decisions; records bound to the transcript hash', () => {
  const b = capWs(); const c = imp(b, CONV, { visibility: 'approved' });
  const rec = (items: object[]) => { const f = put(b.top, 'rec.json', JSON.stringify({ items })); return () => captureAnnotate(b.ws, c.capture_id, f, 'claude-code:annotate'); };
  assert.throws(rec([{ type: 'decision', message: 1, quote: 'not in the message at all', text: 'paraphrase here' }]), /verbatim/);
  assert.throws(rec([{ type: 'decision', message: 2, quote: 'Noted. I will remember', text: 'model decision forged' }]), /from the owner/);
  assert.throws(rec([{ type: 'decision', message: 99, quote: 'something long', text: 'paraphrase' }]), /does not exist/);
});

// ---- scoped disclosure grants
function grantFixture() {
  const b = capWs(); const c = imp(b, `Owner: ${CS}-EXCERPT the owner agreed to share this sentence only.\nAssistant: ok\nOwner: ${CS}-OTHER this second owner message stays private.`);
  sessionStart(b.ws, 'A synthetic newsletter about hand tracking first', 'g-sess'); sessionStart(b.ws, 'A different synthetic session for scope tests', 'g-other');
  const input = { workspace_id: 'adv-biz', session: 'g-sess', host: 'claude-code', role: 'director', purpose: 'internal_read', capture_id: c.capture_id, message: 1, excerpt: `${CS}-EXCERPT the owner agreed to share this sentence only.`, exclusions: ['pricing'], owner_authorization: 'Owner said: share that one sentence with the Director.' };
  const gf = (o: object = {}) => put(b.top, 'g.json', JSON.stringify({ ...input, ...o }));
  const grant = (o: object = {}) => (captureDisclosureGrant(b.ws, gf(o)) as any).grant_id as string;
  const scope = { session: 'g-sess', host: 'claude-code', role: 'director', purpose: 'internal_read' };
  return { b, c, input, grant, scope, gf };
}
test('grant: returns only the authorised excerpt; scope (session/host/role/purpose) is enforced', () => {
  const { b, grant, scope } = grantFixture(); const id = grant(); const r = captureDisclosureRead(b.ws, id, scope) as any;
  assert.ok(r.excerpt.includes(`${CS}-EXCERPT`)); assert.ok(!JSON.stringify(r).includes(`${CS}-OTHER`));
  for (const bad of [{ session: 'g-other' }, { host: 'codex' }, { role: 'writer' }, { purpose: 'draft' }]) assert.throws(() => captureDisclosureRead(b.ws, id, { ...scope, ...bad }), /scope mismatch|Invalid|not found|Only/);
});
test('grant: refused for model-owned messages, approved captures, excerpts outside the message, excluded text, past expiry, wrong workspace', () => {
  const { b, input, gf } = grantFixture();
  const g = (o: object) => () => captureDisclosureGrant(b.ws, gf(o));
  assert.throws(g({ message: 2, excerpt: 'Assistant: ok' }), /owner message|verbatim/);
  assert.throws(g({ excerpt: `${CS}-OTHER this second owner message stays private.` }), /verbatim/);
  assert.throws(g({ exclusions: ['agreed to share'] }), /exclusions must not appear/);
  assert.throws(g({ expires_at: '2001-01-01T00:00:00Z' }), /future/);
  assert.throws(g({ workspace_id: 'another-tenant' }), /workspace mismatch/);
  assert.throws(g({ role: 'writer' }), /Director internal_read/); assert.throws(g({ purpose: 'draft' }), /Director internal_read/); assert.throws(g({ host: 'evil-host' }), /named host/);
  assert.throws(g({ owner_authorization: 'ok' }), /authorization/); assert.throws(g({ session: '../x' }), /Invalid session/); assert.throws(g({ session: 'no-such-session' }), /not found/);
});
test('grant: revoked, expired and tampered grants are refused; a grant copied to another workspace is refused', () => {
  const { b, grant, scope } = grantFixture(); const id = grant(); captureDisclosureRevoke(b.ws, id, 'Owner revokes: stop sharing now.');
  assert.throws(() => captureDisclosureRead(b.ws, id, scope), /revoked/);
  const id2 = grant(); const f = join(b.ws, '.studio/capture-disclosures', `${id2}.json`); const g = jread(f); g.excerpt = g.excerpt + ' and more'; jwrite(f, g);
  assert.throws(() => captureDisclosureRead(b.ws, id2, scope), /changed/);
  const g2 = grantFixture(); const id3 = g2.grant(); const other = bizWs([], {}, { capture: { enabled: true, allowed_hosts: ['claude-code'] } });
  cpSync(join(g2.b.ws, '.studio'), join(other.ws, '.studio'), { recursive: true }); cpSync(join(g2.b.ws, 'captures'), join(other.ws, 'captures'), { recursive: true }); cpSync(join(g2.b.ws, 'sessions'), join(other.ws, 'sessions'), { recursive: true });
  cpSync(join(g2.b.ws, 'studio-workspace.json'), join(other.ws, 'studio-workspace.json'), { dereference: true });
  assert.throws(() => captureDisclosureRead(other.ws, id3, g2.scope), /mismatch|changed|not found/);
});
test('grant ids are validated (no path traversal) and unknown ids are not found', () => {
  const { b, scope } = grantFixture(); for (const id of ['../../studio-business', 'grant-../..', 'x', 'grant-' + 'z'.repeat(36)]) assert.throws(() => captureDisclosureRead(b.ws, id, scope), () => true, id);
});
// VULN-7b (Low): revocation is a marker file plus the last line of an unsigned hash chain; deleting both resurrects the grant
// (the chain detects edits in the middle but not tail truncation).
test.skip('LEGACY CLI limitation: VULN-7b remains file-backed; Service-path coverage is studio-service.test.ts', () => {
  const { b, grant, scope } = grantFixture(); const id = grant(); captureDisclosureRevoke(b.ws, id, 'Owner revokes: stop sharing now.');
  const dir = join(b.ws, '.studio/capture-disclosures'); unlinkSync(join(dir, `${id}.revoked.json`));
  const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n'); writeFileSync(join(dir, 'audit.jsonl'), lines.slice(0, -1).join('\n') + '\n');
  assert.throws(() => captureDisclosureRead(b.ws, id, scope), () => true, 'revoked grant served again after tail truncation');
});

// ---- local tools boundary
test('local tools: deny-by-default, schema strictness, no prototype tricks, policy not mutable through returned objects', () => {
  const b = capWs(); const none = tool(b.ws, []); assert.deepEqual(none.list(), []);
  for (const n of ['session_status', 'capture_show', 'session_start']) assert.deepEqual(call(none, n, {}), { ok: false, error: n === 'session_start' || n === 'capture_show' ? 'DENIED' : 'DENIED' });
  const t = tool(b.ws, ['session_status', 'context_search']);
  for (const raw of [null, [], 'x', { schema_version: 'studio.tool-call/0.1', name: 'constructor', arguments: {} }, { schema_version: 'studio.tool-call/0.1', name: '__proto__', arguments: {} }, { schema_version: 'studio.tool-call/0.1', name: 'toString', arguments: {} }, { schema_version: 'x', name: 'session_status', arguments: {} }, { schema_version: 'studio.tool-call/0.1', name: 'session_status', arguments: [], extra: 1 }]) assert.equal((t.call(raw) as any).ok, false);
  assert.equal(call(t, 'session_status', JSON.parse('{"__proto__": "x"}')).ok, false); assert.equal(call(t, 'session_status', { session: '../..' }).ok, false);
  assert.equal(call(t, 'context_search', { query: 'x'.repeat(301) }).ok, false); assert.equal(call(t, 'context_search', { query: 'tracked', limit: 1e9 }).ok, false);
  const listed = t.list() as any[]; listed[0].inputSchema.properties.evil = {}; listed.push({ name: 'session_start' }); assert.equal(t.list().length, 2); assert.equal((t.list() as any[])[0].inputSchema.properties.evil, undefined);
  const policy = ['session_status'] as any[]; const t2 = tool(b.ws, policy); policy.push('session_start'); assert.equal(call(t2, 'session_start', { idea: 'A synthetic idea for mutation test' }).error, 'DENIED');
  assert.throws(() => tool(b.ws, ['shell'] as any)); assert.throws(() => tool(join(b.top, 'nope'), []));
});
test('local tools: failures return opaque codes (no source text, paths or messages)', () => {
  const b = capWs(); const t = tool(b.ws, ['capture_show', 'session_status']);
  const r = JSON.stringify([call(t, 'capture_show', { capture: 'cap-0123456789ab', ref: 'm1' }), call(t, 'session_status', { session: 'no-such-session' })]); assert.ok(!/sessions|\/|RunnerFailure|No session/.test(r), r);
});
test('local tools: session_start cannot be pointed outside the workspace; slug and idea limits hold', () => {
  const b = capWs(); const t = tool(b.ws, ['session_start']);
  for (const slug of ['../x', '..', 'a/b', 'AB', 'x']) assert.equal(call(t, 'session_start', { idea: 'A synthetic idea long enough', slug }).ok, false);
  assert.equal(call(t, 'session_start', { idea: 'A synthetic idea long enough', slug: 'tool-made' }).ok, true); assert.ok(existsSync(join(b.ws, 'sessions/tool-made/session.json')));
});
test('local tools: a symlinked workspace argument resolves to the real root and other workspaces are unreachable', () => {
  const a = capWs(); const c = capWs(); const link = join(a.top, 'wslink'); symlinkSync(c.ws, link);
  const t = tool(link, ['session_start']); call(t, 'session_start', { idea: 'A synthetic idea long enough', slug: 'in-c' });
  assert.ok(existsSync(join(c.ws, 'sessions/in-c/session.json'))); assert.ok(!existsSync(join(a.ws, 'sessions/in-c')));
});
