/** Run state integrity, approval, cross-workspace isolation, handoff and improvement briefs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, symlinkSync, unlinkSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startAgentRun, approveAgentRun, reviseAgentRun, resumeAgentRun, cancelAgentRun } from '../../src/agent-run.ts';
import { handoffCheck, handoffPromptFor, handoffScoreFile } from '../../src/handoff.ts';
import { inspectRun, listRuns } from '../../src/runner.ts';
import { sessionStart, evidenceAddCatalog, evidenceAddHost, directionApprove, sessionRun, sessionStatus } from '../../src/director-session.ts';
import { improvementPropose, improvementHandoff, improvementList } from '../../src/improvement.ts';
import { FixtureModel } from '../../src/model-port.ts';
import { script, facts, craft, DRAFT } from '../helpers/fixture-script.ts';
import { agentWs, direct, jread, jwrite, put, sha, seen, studioState, dbRows, bizWs, direction, S, FIX, tmp, dump } from './harness.ts';

const run = (over: Parameters<typeof script>[0] = {}) => { const w = agentWs(); const m = new FixtureModel(script(over)); const r = direct(w.dir, () => {}, m); assert.ok(r.out, String(r.err)); const snap = jread(join(r.out.artifact_dir, 'run-snapshot.json')); return { ...w, m, id: r.out.run_id as string, art: r.out.artifact_dir as string, snap }; };
const blocked = (id: string) => script({ fact_reviewer: () => JSON.stringify(facts([{ claim_id: 'c01', verdict: 'unsupported', note: 'no support' }, { claim_id: 'c02', verdict: 'verified', source_id: 'src_2', source_excerpt: '9 of them said they had waited for a tool that was out late.' }, { claim_id: 'c03', verdict: 'verified', source_id: 'src_3', source_excerpt: 'test automated reminder texts for one month before buying booking software' }])) });
void blocked;

test('approval needs the exact current digest; stale, short, uppercase and wrong digests are refused', () => {
  const r = run();
  for (const d of ['0'.repeat(64), r.snap.current_digest.toUpperCase(), r.snap.current_digest.slice(0, 63), 'x'.repeat(64), r.snap.current_digest + ' ']) assert.throws(() => approveAgentRun(r.dir, r.id, d));
  assert.equal(approveAgentRun(r.dir, r.id, r.snap.current_digest).publication_authorized, false);
  assert.throws(() => approveAgentRun(r.dir, r.id, r.snap.current_digest), /already approved/);
});
test('draft bytes edited after review: approval is refused for old and new digests', () => {
  const r = run(); writeFileSync(join(r.art, 'draft-v001.md'), DRAFT + '\n\nA sentence slipped in after QA.');
  assert.throws(() => approveAgentRun(r.dir, r.id, r.snap.current_digest), /do not match|changed/);
  assert.throws(() => approveAgentRun(r.dir, r.id, sha(readFileSync(join(r.art, 'draft-v001.md'), 'utf8'))), /do not match|changed|Stale/);
});
test('QA artifacts deleted/edited after review (factual-qa, blockers, claim manifest) block approval', () => {
  for (const f of ['factual-qa-v001.json', 'craft-qa-v001.json', 'claim-manifest-v001.json', 'blockers-v001.json', 'review-package.md', 'run-snapshot.json']) {
    const r = run(); const p = join(r.art, f); writeFileSync(p, readFileSync(p, 'utf8') + ' '); assert.throws(() => approveAgentRun(r.dir, r.id, r.snap.current_digest), /changed|missing/, f);
    const q = run(); unlinkSync(join(q.art, f)); assert.throws(() => approveAgentRun(q.dir, q.id, q.snap.current_digest), /missing|unsafe|ENOENT|predates/, f);
  }
});
test('symlinked artifact replacement is refused', () => {
  const r = run(); const evil = put(tmp('adv-sl-'), 'x.json', '{}'); unlinkSync(join(r.art, 'blockers-v001.json')); symlinkSync(evil, join(r.art, 'blockers-v001.json'));
  assert.throws(() => approveAgentRun(r.dir, r.id, r.snap.current_digest), /missing|unsafe/);
});
test('SQLite status forged to WAITING_FOR_OWNER on a run that never reached QA cannot be approved', () => {
  const w = agentWs(); const m = new FixtureModel(script({ writer: () => 'not json' })); const r = direct(w.dir, () => {}, m); assert.ok(r.err);
  const id = (listRowId(w.dir)); const db = new DatabaseSync(join(w.dir, '.studio/runs.sqlite')); db.prepare("UPDATE runs SET status='WAITING_FOR_OWNER' WHERE run_id=?").run(id); db.close();
  assert.throws(() => approveAgentRun(w.dir, id, 'a'.repeat(64)));
});
const listRowId = (dir: string) => dbRows(dir, 'SELECT run_id FROM runs ORDER BY created_at DESC LIMIT 1')[0].run_id as string;
test('open blockers require an explicit allowed decision with a reason; unknown ids and wrong decision kinds are refused', () => {
  const r = run({ fact_reviewer: () => JSON.stringify(facts([{ claim_id: 'c01', verdict: 'unsupported', note: 'no support' }, { claim_id: 'c02', verdict: 'disputed', note: 'x' }, { claim_id: 'c03', verdict: 'not_checked' }])) });
  assert.ok(r.snap.open_blockers > 0); const dig = r.snap.current_digest;
  assert.throws(() => approveAgentRun(r.dir, r.id, dig), /no owner decision/);
  const write = (decisions: object) => { const f = put(r.dir, 'dec.json', JSON.stringify({ schema_version: 'studio.owner-decisions/0.1', decisions })); return f; };
  const all = (decision: string, reason = 'owner reviewed this blocker') => Object.fromEntries(r.snap.blockers.map((b: string) => [b, { decision, reason }]));
  assert.throws(() => approveAgentRun(r.dir, r.id, dig, write(all('disclosure_approved'))), /not allowed/);
  assert.throws(() => approveAgentRun(r.dir, r.id, dig, write(all('owner_attests', 'short'))), /reason/);
  assert.throws(() => approveAgentRun(r.dir, r.id, dig, write({ ...all('owner_attests'), 'claim:zzz': { decision: 'owner_attests', reason: 'a long reason here' } })), /not open/);
  assert.throws(() => approveAgentRun(r.dir, r.id, dig, put(r.dir, 'dec2.json', '{"decisions":{}}')), /schema_version/);
  assert.throws(() => approveAgentRun(r.dir, r.id, dig, write({ __proto__: { decision: 'owner_attests', reason: 'long enough reason' } })), /no owner decision/);
});
test('revision with a new draft: previous approval is invalidated and the old digest is stale', () => {
  const r = run(); approveAgentRun(r.dir, r.id, r.snap.current_digest); const fb = put(r.dir, 'fb.md', 'Please add one more sentence about the committee.');
  const rev = reviseAgentRun(r.dir, r.id, fb, { model: new FixtureModel(script({ writer: (req, n) => JSON.stringify({ title: 'T', draft_markdown: DRAFT + '\n\nOne more sentence about the committee follows here.', claims: JSON.parse(script()(req, n)).claims, notes_for_owner: [] }) })) }) as any;
  const snap = jread(join(r.art, 'run-snapshot.json')); assert.equal(snap.approved_digest, null); assert.notEqual(snap.current_digest, r.snap.current_digest);
  assert.throws(() => approveAgentRun(r.dir, r.id, r.snap.current_digest), /Stale/); void rev;
});
test('cancelled runs cannot be resumed or approved; approved runs cannot be cancelled', () => {
  const r = run(); cancelAgentRun(r.dir, r.id, 'owner cancelled this run'); assert.throws(() => resumeAgentRun(r.dir, r.id, { model: r.m }), /cancelled/); assert.throws(() => approveAgentRun(r.dir, r.id, r.snap.current_digest), /Only WAITING/);
  const q = run(); approveAgentRun(q.dir, q.id, q.snap.current_digest); assert.throws(() => cancelAgentRun(q.dir, q.id, 'try to cancel approved'), /terminal/);
});
test('cross-workspace: run ids, artifacts and approvals do not resolve in another workspace', () => {
  const a = run(); const b = agentWs();
  assert.throws(() => inspectRun(b.dir, a.id).request); assert.throws(() => approveAgentRun(b.dir, a.id, a.snap.current_digest), /Unknown run/);
  assert.throws(() => reviseAgentRun(b.dir, a.id, put(b.dir, 'fb.md', 'Feedback long enough here.')), /Unknown run/); assert.throws(() => resumeAgentRun(b.dir, a.id, { model: a.m }), /Unknown run/);
  assert.throws(() => handoffPromptFor(b.dir, a.id), /Unknown run/); assert.throws(() => handoffScoreFile(b.dir, a.id, put(b.dir, 'ans.json', '{}')), /Unknown run/);
  assert.deepEqual(listRuns(b.dir), []);
});
test('cross-workspace: a run row copied into a workspace with a different workspace_id is refused', () => {
  const a = run(); const b = agentWs(); const wsB = jread(join(b.dir, 'studio-workspace.json')); wsB.workspace_id = 'other-tenant-ws'; jwrite(join(b.dir, 'studio-workspace.json'), wsB);
  cpSync(join(a.dir, '.studio'), join(b.dir, '.studio'), { recursive: true });
  assert.throws(() => approveAgentRun(b.dir, a.id, a.snap.current_digest), /another workspace/); assert.throws(() => resumeAgentRun(b.dir, a.id, { model: a.m }), /another workspace/);
});
test('STUDIO_ALLOWED_WORKSPACE_ROOT pins the launch root; a different workspace is refused', () => {
  const a = agentWs(), b = agentWs(); process.env.STUDIO_ALLOWED_WORKSPACE_ROOT = a.dir;
  try { const r = direct(b.dir, () => {}); assert.match(String(r.err?.message), /differs from trusted launch/); assert.equal(r.model.calls.length, 0); } finally { delete process.env.STUDIO_ALLOWED_WORKSPACE_ROOT; }
});
test('a symlinked .studio or runs.sqlite is refused (state cannot be redirected to another workspace)', () => {
  const a = run(); const b = agentWs(); const real = tmp('adv-state-'); cpSync(join(a.dir, '.studio'), real, { recursive: true });
  symlinkSync(real, join(b.dir, '.studio')); assert.throws(() => listRuns(b.dir), /symbolic/);
});
test('inspect/status JSON for a run contains no source text from approved sources beyond what the run owns, and never restricted text', () => {
  const w = agentWs(); const SENT = 'ZEBRA-QUOKKA-7731-STATUS'; put(w.dir, 'sources/res.md', `${SENT} restricted note about the budget. ` + ' padding sentence for length requirement of evidence.'.repeat(2));
  const m = new FixtureModel(script()); const r = direct(w.dir, q => { q.source_paths.push('sources/res.md'); }, m); assert.ok(r.err);
  assert.deepEqual(listRuns(w.dir), [], 'gate fires before a run row is created'); const j = JSON.stringify(listRuns(w.dir)); assert.ok(!j.includes(SENT)); assert.ok(!studioState(w.dir).includes(SENT));
});
// ---- handoff
test('handoff prompt contains only the two portable files and no source text', () => {
  const r = run(); const h = handoffPromptFor(r.dir, r.id); assert.ok(!h.user.includes('Volunteers texted')); assert.ok(!h.user.includes('<source '));
  const m = new FixtureModel(() => JSON.stringify({ run_id: r.id, state: 'WAITING_FOR_OWNER' })); handoffCheck(r.dir, r.id, 'haiku', { model: m }); assert.equal(m.calls[0].role, 'handoff_reader'); assert.ok(!seen(m).includes('<source '));
});
test('handoff after a source is reclassified restricted is refused before the reader model is invoked', () => {
  const r = run(); const reg = jread(join(r.dir, 'studio-workspace.json')); reg.sources[0].visibility = 'restricted'; jwrite(join(r.dir, 'studio-workspace.json'), reg);
  const m = new FixtureModel(() => '{}'); assert.throws(() => handoffCheck(r.dir, r.id, 'haiku', { model: m }), /Restricted evidence/); assert.equal(m.calls.length, 0); assert.throws(() => handoffPromptFor(r.dir, r.id), /Restricted/);
});
// VULN-7a (Low): handoff-check/handoff-prompt read run-snapshot.json and review-package.md without verifying them against
// the recorded artifact digests (approve does). Anything written into those files is sent to the handoff_reader model.
test('VULN-7a: handoff refuses a review package or snapshot edited after it was recorded', () => {
  const r = run(); const SENT = 'ZEBRA-QUOKKA-7731-HANDOFF'; writeFileSync(join(r.art, 'review-package.md'), readFileSync(join(r.art, 'review-package.md'), 'utf8') + `\n${SENT} injected text pasted by anyone with file access\n`);
  const m = new FixtureModel(() => '{}'); let err: unknown = null; try { handoffCheck(r.dir, r.id, 'haiku', { model: m }); } catch (e) { err = e; }
  assert.ok(err && m.calls.length === 0 && !seen(m).includes(SENT), 'tampered review package was sent to the reader model');
});
// ---- improvement briefs
test('improvement brief and proposal for restricted evidence carry paths and hashes only, never text', () => {
  const b = bizWs(); sessionStart(b.ws, 'A synthetic newsletter about hand tracking first', 'imp-sess'); evidenceAddCatalog(b.ws, 'imp-sess', 'journal'); evidenceAddCatalog(b.ws, 'imp-sess', 'process', 'Public');
  const ev = jread(join(b.ws, 'sessions/imp-sess/session.json')).evidence[0];
  const f = put(b.top, 'p.json', JSON.stringify({ owner_request: 'Owner: please look into this problem.', title: 'Fix the runner gate', finding: 'The gate message is unclear for restricted sources.', proposed_change: 'Clarify the refusal message text.', affected: ['core:studio-runner/src/agent-run.ts'], tests_required: ['npm test => pass', 'second asset regression'], references: [{ kind: 'evidence', ref: ev.path }] }));
  const p = improvementPropose(b.ws, 'imp-sess', f, 'claude-code:review') as any; improvementHandoff(b.ws, p.id, 'codex');
  const all = dump(join(b.ws, 'improvements')) + JSON.stringify(improvementList(b.ws)) + JSON.stringify(sessionStatus(b.ws)); assert.ok(!all.includes(S.restrictedDoc) && !all.includes(S.secretHeading) && !all.includes(S.redact));
});
test('improvement references cannot escape: dotdot artifact names, absolute and symlinked files, foreign sessions', () => {
  const b = bizWs(); sessionStart(b.ws, 'A synthetic newsletter about hand tracking first', 'imp-two'); evidenceAddCatalog(b.ws, 'imp-two', 'process', 'Public');
  const base = { owner_request: 'Owner: please look into this problem.', title: 'Fix the runner gate', finding: 'The gate message is unclear here.', proposed_change: 'Clarify the refusal message text.', affected: ['core:studio-runner/src/agent-run.ts'], tests_required: ['x => y'] };
  symlinkSync(join(b.outside, 'secret.md'), join(b.ws, 'link.md'));
  for (const ref of [{ kind: 'session_artifact', ref: '..' }, { kind: 'session_artifact', ref: '../x' }, { kind: 'file', ref: '/etc/passwd' }, { kind: 'file', ref: '../outside/secret.md' }, { kind: 'file', ref: 'link.md' }, { kind: 'file', ref: 'core:../../etc/passwd' }, { kind: 'evidence', ref: 'sources/other/x.md' }, { kind: 'capture_item', ref: 'cap-0123456789ab#m1' }]) {
    assert.throws(() => improvementPropose(b.ws, 'imp-two', put(b.top, 'p.json', JSON.stringify({ ...base, references: [ref] })), 'claude-code:review'), () => true, JSON.stringify(ref));
  }
});
