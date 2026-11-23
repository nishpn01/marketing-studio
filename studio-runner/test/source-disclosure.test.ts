import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, symlinkSync, realpathSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentRun, resumeAgentRun, reviseAgentRun, approveAgentRun, inspectSource } from '../src/agent-run.ts';
import { handoffCheck, handoffPromptFor } from '../src/handoff.ts';
import { sourceDisclosureGrant, sourceDisclosureList, sourceDisclosureRevoke, resolveSourceDisclosure } from '../src/source-disclosure.ts';
import { inspectRun, REPO_ROOT } from '../src/runner.ts';
import { FixtureModel } from '../src/model-port.ts';
import { script, brief } from './helpers/fixture-script.ts';

const FIX = join(REPO_ROOT, 'studio-runner/fixtures/agent-sample');
const SECRET = 'ZEBRA-QUOKKA-7731', TAIL = 'PRIVATE-TAIL-5521', HDR = 'HDR-SENTINEL-4410', QUOTE = 'OWNER-QUOTE-SENTINEL-9902';
const EXCERPT = '14 members answered a paper question sheet. 9 of them said they had waited for a tool that was out late.';
const BODY = `# Member comments (synthetic)\n\n- "I never know when the ladder will be back." ${SECRET} is a private aside.\n- ${EXCERPT}\n- ${TAIL} should never leave this file.\n`;
const HEADER = `<!-- studio evidence\n{"visibility":"restricted","title":"${HDR}"}\n-->\n\n`;
const SRC = 'sources/member-comments.md';
const ALL = [SECRET, TAIL, HDR, QUOTE];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'src-disc-'));
  cpSync(FIX, dir, { recursive: true });
  const reg = JSON.parse(readFileSync(join(dir, 'studio-workspace.json'), 'utf8'));
  reg.sources.find((x: any) => x.path === SRC).visibility = 'restricted'; writeFileSync(join(dir, 'studio-workspace.json'), JSON.stringify(reg));
  writeFileSync(join(dir, SRC), HEADER + BODY);
  mkdirSync(join(dir, 'sessions', 'sample-session'), { recursive: true });
  writeFileSync(join(dir, 'sessions', 'sample-session', 'session.json'), JSON.stringify({ schema_version: 'studio.session/0.1', slug: 'sample-session', evidence: [] }));
  const r = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
  r.provider = 'fixture'; r.disclosure = { session: 'sample-session', host: 'codex' };
  const req = (edit: (r: any) => void = () => {}) => { const x = structuredClone(r); edit(x); const p = join(dir, 'request.json'); writeFileSync(p, JSON.stringify(x)); return p; };
  const grant = (over: object = {}) => {
    const f = join(dir, `grant-input-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify({ workspace_id: 'riverside-tool-library', session: 'sample-session', host: 'codex', purpose: 'drafting', roles: ['director', 'writer', 'fact_reviewer'], source_path: SRC, excerpts: [EXCERPT], owner_authorization: `You may use only this line. ${QUOTE}`, ...over }));
    return sourceDisclosureGrant(dir, f, inspectSource) as any;
  };
  return { dir, req, grant };
}
const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
/** No sentinel from outside the grant may appear in any artifact, receipt, event or review package of the run. */
function assertNoLeak(dir: string, id: string) {
  const text = walk(join(dir, '.studio', 'artifacts', id)).map(p => readFileSync(p, 'utf8')).join('\n') + JSON.stringify(inspectRun(dir, id));
  for (const s of ALL) assert.ok(!text.includes(s), `leaked ${s}`);
}
const prompts = (m: FixtureModel) => m.calls.map(c => c.system + '\n' + c.prompt).join('\n');
const noModel = () => new FixtureModel(script());

test('no grant, no disclosure context: fails closed before any model call or run artifact', () => {
  const f = fixture(); const m = noModel();
  assert.throws(() => startAgentRun(f.dir, f.req(), { model: m }), /Restricted evidence.*no_grant/);
  assert.throws(() => startAgentRun(f.dir, f.req(r => { delete r.disclosure; }), { model: m }), /Restricted evidence.*no_context/);
  assert.equal(m.calls.length, 0); assert.equal(existsSync(join(f.dir, '.studio/artifacts')), false);
});

test('narrow grant: models see only the granted excerpt; nothing else leaks anywhere; fact cap stays', () => {
  const f = fixture(); const g = f.grant(); const m = noModel();
  const out = startAgentRun(f.dir, f.req(), { model: m }) as any;
  assert.equal(out.status, 'WAITING_FOR_OWNER');
  const all = prompts(m);
  assert.ok(all.includes(EXCERPT)); for (const s of ALL) assert.ok(!all.includes(s), s);
  assert.ok(!m.calls.find(c => c.role === 'craft_reviewer')!.prompt.includes(EXCERPT), 'craft reviewer never sees sources');
  assertNoLeak(f.dir, out.run_id);
  const qa = JSON.parse(readFileSync(join(f.dir, '.studio/artifacts', out.run_id, 'factual-qa-v001.json'), 'utf8'));
  assert.equal(qa.claims.find((c: any) => c.claim_id === 'c02').verdict, 'private_approval_required');
  const idx = readFileSync(join(f.dir, '.studio/artifacts', out.run_id, 'source-index.json'), 'utf8'); assert.ok(idx.includes('"restricted": true'));
  const list = sourceDisclosureList(f.dir); assert.equal(list[0].status, 'active'); assert.equal(list[0].grant_id, g.grant_id);
  assert.ok(!JSON.stringify(list).includes(EXCERPT) && !JSON.stringify(g).includes(QUOTE));
  assert.equal(g.publication_authorized, false); assert.equal(g.authenticated, false);
});

test('revocation mid-run stops the next model call; later resume, revise, approve and handoff all refuse', () => {
  const f = fixture(); const g = f.grant();
  // Another process cannot take the workspace lock mid-run, so emulate a revocation marker landing between calls.
  const marker = (id: string) => writeFileSync(join(f.dir, '.studio', 'source-disclosures', `${id}.revoked.json`), '{}');
  const m = new FixtureModel(script({ director: () => { marker(g.grant_id); return JSON.stringify(brief()); } }));
  let runId = '';
  try { startAgentRun(f.dir, f.req(), { model: m }); assert.fail('should refuse'); } catch (e: any) { assert.match(e.message, /Restricted evidence.*revoked/); assert.ok(!ALL.some(s => e.message.includes(s))); runId = e.runId; }
  assert.deepEqual(m.calls.map(c => c.role), ['director']);
  assert.throws(() => resumeAgentRun(f.dir, runId, { model: m }), /Restricted evidence|Run is BLOCKED/);
  assert.equal(m.calls.length, 1);
  const g2 = f.grant(); const m2 = noModel(); const out = startAgentRun(f.dir, f.req(), { model: m2 }) as any; assert.equal(out.status, 'WAITING_FOR_OWNER');
  sourceDisclosureRevoke(f.dir, g2.grant_id, 'Owner revokes this access again.');
  const fb = join(f.dir, 'fb.md'); writeFileSync(fb, 'Make the ending clearer.');
  const n = m2.calls.length;
  assert.throws(() => approveAgentRun(f.dir, out.run_id, 'a'.repeat(64)), /Restricted evidence.*revoked/);
  assert.throws(() => reviseAgentRun(f.dir, out.run_id, fb, { model: m2 }), /Restricted evidence.*revoked/);
  assert.throws(() => handoffCheck(f.dir, out.run_id, 'fixture', { model: m2 }), /Restricted evidence/);
  assert.throws(() => handoffPromptFor(f.dir, out.run_id), /Restricted evidence/);
  assert.equal(m2.calls.length, n);
  assert.throws(() => sourceDisclosureRevoke(f.dir, g2.grant_id, 'Owner revokes this access again.'), /already revoked/);
});

test('stale source: edits before or during a run refuse the next model call', () => {
  const f = fixture(); f.grant();
  writeFileSync(join(f.dir, SRC), HEADER + BODY + '\nAn edit after the grant.\n');
  assert.throws(() => startAgentRun(f.dir, f.req(), { model: noModel() }), /Restricted evidence.*stale_source/);
  const g = fixture(); g.grant();
  const m = new FixtureModel(script({ director: () => { writeFileSync(join(g.dir, SRC), HEADER + BODY + '\nMid-run edit.\n'); return JSON.stringify(brief()); } }));
  assert.throws(() => startAgentRun(g.dir, g.req(), { model: m }), /Restricted evidence/);
  assert.deepEqual(m.calls.map(c => c.role), ['director']);
});

test('tampered grant file, ledger or revocation marker fail closed without echoing text', () => {
  const f = fixture(); const g = f.grant(); const dir = join(f.dir, '.studio', 'source-disclosures');
  const gp = join(dir, `${g.grant_id}.json`), original = readFileSync(gp, 'utf8');
  const bad = JSON.parse(original); bad.excerpts = [`- ${TAIL} should never leave this file.`]; writeFileSync(gp, JSON.stringify(bad));
  assert.throws(() => startAgentRun(f.dir, f.req(), { model: noModel() }), (e: any) => /tampered_or_unavailable/.test(e.message) && !ALL.some(s => e.message.includes(s)));
  writeFileSync(gp, original);
  const log = join(dir, 'audit.jsonl'), l = readFileSync(log, 'utf8');
  writeFileSync(log, l.replace('"source_path"', '"source_pat"'));
  assert.throws(() => startAgentRun(f.dir, f.req(), { model: noModel() }), /tampered_or_unavailable/);
  writeFileSync(log, l);
  assert.equal((startAgentRun(f.dir, f.req(), { model: noModel() }) as any).status, 'WAITING_FOR_OWNER');
  sourceDisclosureRevoke(f.dir, g.grant_id, 'Owner revokes this access now.');
  writeFileSync(log, l); // ledger tail loss: marker still revokes
  assert.throws(() => startAgentRun(f.dir, f.req(), { model: noModel() }), /Restricted evidence.*revoked/);
});

test('grants do not cross workspaces, copies, sessions, hosts, roles or purposes', () => {
  const f = fixture(); f.grant(); f.req();
  const copy = mkdtempSync(join(tmpdir(), 'src-disc-copy-')); cpSync(f.dir, copy, { recursive: true });
  assert.throws(() => startAgentRun(copy, join(copy, 'request.json'), { model: noModel() }), /Restricted evidence.*scope_mismatch/);
  const other = fixture(); // different workspace dir; replay the grant files into it
  cpSync(join(f.dir, '.studio', 'source-disclosures'), join(other.dir, '.studio', 'source-disclosures'), { recursive: true });
  assert.throws(() => startAgentRun(other.dir, other.req(), { model: noModel() }), /Restricted evidence.*scope_mismatch/);
  mkdirSync(join(f.dir, 'sessions', 'other-session'), { recursive: true });
  writeFileSync(join(f.dir, 'sessions', 'other-session', 'session.json'), JSON.stringify({ schema_version: 'studio.session/0.1', slug: 'other-session' }));
  assert.throws(() => startAgentRun(f.dir, f.req(r => { r.disclosure.session = 'other-session'; }), { model: noModel() }), /scope_mismatch/);
  assert.throws(() => startAgentRun(f.dir, f.req(r => { r.disclosure.host = 'chatgpt'; }), { model: noModel() }), /scope_mismatch/);
  const r2 = fixture(); r2.grant({ roles: ['writer', 'fact_reviewer'] });
  assert.throws(() => startAgentRun(r2.dir, r2.req(), { model: noModel() }), /role_not_granted/);
  const p = fixture(); p.grant({ purpose: 'internal_read' }); p.grant({ purpose: 'publication' });
  assert.throws(() => startAgentRun(p.dir, p.req(), { model: noModel() }), /scope_mismatch/);
  const body = HEADER + BODY;
  assert.throws(() => resolveSourceDisclosure(realpathSync(p.dir), { path: SRC, digest: require_sha(body), body, session: 'sample-session', host: 'codex', purpose: 'publication', roles: ['writer'] }), /purpose_unsupported/);
});

test('duplicate grants for the same role are ambiguous; disjoint grants compose; expiry is enforced', () => {
  const f = fixture(); f.grant(); f.grant({ roles: ['writer'] });
  assert.throws(() => startAgentRun(f.dir, f.req(), { model: noModel() }), /Restricted evidence.*ambiguous/);
  const g = fixture(); g.grant({ roles: ['director'] }); g.grant({ roles: ['writer', 'fact_reviewer'] });
  assert.equal((startAgentRun(g.dir, g.req(), { model: noModel() }) as any).status, 'WAITING_FOR_OWNER');
  const e = fixture(); e.grant({ expires_at: new Date(Date.now() + 60000).toISOString() });
  const real = Date.now;
  try { Date.now = () => real() + 120000; assert.throws(() => startAgentRun(e.dir, e.req(), { model: noModel() }), /Restricted evidence.*expired/); } finally { Date.now = real; }
  assert.throws(() => e.grant({ expires_at: '2000-01-01T00:00:00.000Z' }), /expiry/);
});

test('header and classification forgery cannot widen disclosure', () => {
  const f = fixture(); f.grant();
  // Flip the evidence header to approved: workspace registry still says restricted; digest changed, so the old grant is stale.
  writeFileSync(join(f.dir, SRC), HEADER.replace('restricted', 'approved') + BODY);
  const m = noModel();
  assert.throws(() => startAgentRun(f.dir, f.req(), { model: m }), /Restricted evidence.*stale_source/);
  f.grant(); // re-granted: the model still receives only the excerpt, not the whole source
  assert.equal((startAgentRun(f.dir, f.req(), { model: m }) as any).status, 'WAITING_FOR_OWNER');
  for (const s of [SECRET, TAIL]) assert.ok(!prompts(m).includes(s));
  // Session-recorded classification: a Director-style path whose session.json says approved but whose header says restricted stays restricted.
  const d = fixture(); const rel = 'sources/sample-session/web-1.md'; mkdirSync(join(d.dir, 'sources', 'sample-session'), { recursive: true });
  const text = HEADER + BODY; writeFileSync(join(d.dir, rel), text);
  writeFileSync(join(d.dir, 'sessions', 'sample-session', 'session.json'), JSON.stringify({ schema_version: 'studio.session/0.1', slug: 'sample-session', evidence: [{ path: rel, kind: 'web', visibility: 'approved', sha256: require_sha(text) }] }));
  assert.throws(() => startAgentRun(d.dir, d.req(r => { r.source_paths = [rel]; }), { model: noModel() }), /Restricted evidence.*no_grant/);
});
import { createHash } from 'node:crypto';
const require_sha = (t: string) => createHash('sha256').update(t).digest('hex');

test('symlink and path tricks', () => {
  const f = fixture(); f.grant();
  assert.throws(() => f.grant({ source_path: 'sources/../studio-workspace.json' }), /relative to sources/);
  assert.throws(() => f.grant({ source_path: 'sources/volunteer-log.md' }), /only for restricted sources/);
  assert.throws(() => f.grant({ source_path: 'sources/missing.md' }));
  // a grant for another path never applies
  const o = fixture(); o.grant(); const reg = JSON.parse(readFileSync(join(o.dir, 'studio-workspace.json'), 'utf8'));
  writeFileSync(join(o.dir, 'sources', 'copy.md'), HEADER + BODY); reg.sources.push({ path: 'sources/copy.md', visibility: 'restricted' }); writeFileSync(join(o.dir, 'studio-workspace.json'), JSON.stringify(reg));
  assert.throws(() => startAgentRun(o.dir, o.req(r => { r.source_paths = ['sources/copy.md', ...r.source_paths.slice(1)]; }), { model: noModel() }), /no_grant/);
  // symlinked source
  const s = fixture(); s.grant(); rmSync(join(s.dir, SRC)); const real = join(s.dir, 'real.md'); writeFileSync(real, HEADER + BODY); symlinkSync(real, join(s.dir, SRC));
  assert.throws(() => startAgentRun(s.dir, s.req(), { model: noModel() }), /symlink|outside/i);
  // symlinked ledger or grant directory contents
  const l = fixture(); const g = l.grant(); const dir = join(l.dir, '.studio', 'source-disclosures');
  renameSync(join(dir, 'audit.jsonl'), join(l.dir, 'moved.jsonl')); symlinkSync(join(l.dir, 'moved.jsonl'), join(dir, 'audit.jsonl'));
  assert.throws(() => startAgentRun(l.dir, l.req(), { model: noModel() }), /tampered_or_unavailable/);
  assert.throws(() => sourceDisclosureRevoke(l.dir, g.grant_id, 'Owner revokes this access now.'), /symlink/);
});

test('excerpts must be exact, in the source body, bounded and distinct', () => {
  const f = fixture();
  assert.throws(() => f.grant({ excerpts: ['This sentence is not in the source at all.'] }), /verbatim/);
  assert.throws(() => f.grant({ excerpts: [HDR + ' title'] }), /verbatim/);
  assert.throws(() => f.grant({ excerpts: [`"title":"${HDR}"`] }), /verbatim/);
  assert.throws(() => f.grant({ excerpts: [] }), /excerpts/);
  assert.throws(() => f.grant({ excerpts: ['short'] }), /bounded/);
  assert.throws(() => f.grant({ excerpts: [EXCERPT, EXCERPT] }), /distinct/);
  assert.throws(() => f.grant({ excerpts: Array.from({ length: 6 }, (_, i) => `- ${'x'.repeat(10)}${i}`) }), /excerpts/);
  const big = fixture(); writeFileSync(join(big.dir, SRC), HEADER + 'A'.repeat(2500) + '\n' + BODY);
  assert.throws(() => big.grant({ excerpts: ['A'.repeat(2100)] }), /bounded/);
  assert.throws(() => f.grant({ owner_authorization: 'ok' }), /authorization/);
  assert.throws(() => f.grant({ roles: ['handoff_reader'] }), /roles/);
  assert.throws(() => f.grant({ host: 'nobody' }), /host/);
  assert.throws(() => f.grant({ workspace_id: 'other' }), /workspace mismatch/);
  assert.throws(() => f.grant({ purpose: 'anything' }), /purpose/);
  assert.throws(() => f.grant({ bind_direction: true }), /approved direction/);
});

test('direction binding: replacing the approved direction invalidates a bound grant', () => {
  const f = fixture(); const dp = join(f.dir, 'sessions', 'sample-session', 'direction.json'); writeFileSync(dp, '{"angle":"one"}');
  f.grant({ bind_direction: true });
  assert.equal((startAgentRun(f.dir, f.req(), { model: noModel() }) as any).status, 'WAITING_FOR_OWNER');
  writeFileSync(dp, '{"angle":"two"}');
  assert.throws(() => startAgentRun(f.dir, f.req(), { model: noModel() }), /scope_mismatch/);
});

test('request disclosure context is validated', () => {
  const f = fixture();
  assert.throws(() => startAgentRun(f.dir, f.req(r => { r.disclosure = { session: 'x', host: 'codex' }; }), { model: noModel() }), /disclosure needs/);
  assert.throws(() => startAgentRun(f.dir, f.req(r => { r.disclosure = { session: 'sample-session', host: 'evil' }; }), { model: noModel() }), /disclosure needs/);
});
