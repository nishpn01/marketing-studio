import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentRun, resumeAgentRun, reviseAgentRun, approveAgentRun, cancelAgentRun } from '../src/agent-run.ts';
import { handoffCheck, expectedHandoff, handoffScoreFile, handoffPromptFor } from '../src/handoff.ts';
import { inspectRun, listRuns, REPO_ROOT } from '../src/runner.ts';
import { FixtureModel } from '../src/model-port.ts';
import { script, facts, craft, draft, DRAFT } from './helpers/fixture-script.ts';

const FIX = join(REPO_ROOT, 'studio-runner/fixtures/agent-sample');
function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'e5-ws-'));
  cpSync(FIX, dir, { recursive: true });
  const r = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')); r.provider = 'fixture';
  writeFileSync(join(dir, 'request.json'), JSON.stringify(r));
  return { dir, req: join(dir, 'request.json') };
}
const art = (dir: string, id: string, f: string) => join(dir, '.studio/artifacts', id, f);
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const snap = (dir: string, id: string) => json(art(dir, id, 'run-snapshot.json'));
const status = (dir: string, id: string) => inspectRun(dir, id).status;
const evs = (dir: string, id: string, t: string) => inspectRun(dir, id).events.filter((e: any) => e.event_type === t);
function clean() { const { dir, req } = ws(); const model = new FixtureModel(script()); const out = startAgentRun(dir, req, { model }) as any; return { dir, id: out.run_id as string, model }; }
/** A run with one not_checked claim (c03 omitted by reviewer) and one must-fix craft finding. */
function blocked() {
  const { dir, req } = ws();
  const model = new FixtureModel(script({
    fact_reviewer: () => JSON.stringify(facts(facts().claims.slice(0, 2))),
    craft_reviewer: () => JSON.stringify(craft({ verdict: 'revise', findings: [{ excerpt: 'There is no result yet', problem: 'ending is flat', suggestion: 'say what will be measured', severity: 'must' }] })),
  }));
  const req2 = JSON.parse(readFileSync(req, 'utf8')); req2.budget.max_revision_rounds = 0; writeFileSync(req, JSON.stringify(req2));
  const out = startAgentRun(dir, req, { model }) as any;
  return { dir, id: out.run_id as string };
}
function decisions(dir: string, d: object) { const p = join(dir, 'decisions.json'); writeFileSync(p, JSON.stringify({ schema_version: 'studio.owner-decisions/0.1', decisions: d })); return p; }

test('handoff refuses old runs when source provenance is restricted', () => {
  const { dir, id } = clean();
  writeFileSync(join(dir, 'sources/member-comments.md'), '<!-- studio evidence\n{"visibility":"restricted"}\n-->\nSENSITIVE-SENTINEL-OLD-RUN must stay private.');
  const model = new FixtureModel(script());
  assert.throws(() => handoffCheck(dir, id, 'fixture', { model }), /Restricted evidence/);
  assert.throws(() => handoffPromptFor(dir, id), /Restricted evidence/);
  assert.equal(model.calls.length, 0);
});

test('revision refuses restricted source drift before saving feedback or calling a model', () => {
  const { dir, id } = clean();
  writeFileSync(join(dir, 'sources/member-comments.md'), '<!-- studio evidence\n{"visibility":"restricted"}\n-->\nSENSITIVE-SENTINEL-REVISION must stay private.');
  const feedback = join(dir, 'feedback.md'); writeFileSync(feedback, 'Make the ending clearer.');
  const model = new FixtureModel(script());
  assert.throws(() => reviseAgentRun(dir, id, feedback, { model }), /Restricted evidence/);
  assert.equal(model.calls.length, 0);
  assert.equal(existsSync(art(dir, id, 'feedback-v001.md')), false);
});

test('approve: exact current digest on a clean run -> ASSET_APPROVED, unauthenticated, never publication', () => {
  const { dir, id } = clean();
  const s = snap(dir, id);
  const out = approveAgentRun(dir, id, s.current_digest) as any;
  assert.equal(out.status, 'ASSET_APPROVED'); assert.equal(out.authenticated, false); assert.equal(out.publication_authorized, false);
  const a = json(art(dir, id, 'approval-v001.json'));
  assert.equal(a.digest, s.current_digest); assert.equal(a.authenticated, false); assert.match(a.authentication_note, /not a signed owner approval/);
  const s2 = snap(dir, id);
  assert.equal(s2.state, 'ASSET_APPROVED'); assert.equal(s2.approved_digest, s.current_digest); assert.equal(s2.publication_authorized, false);
  assert.match(readFileSync(art(dir, id, 'review-package.md'), 'utf8'), /Not authenticated\. Not a publication authorization\./);
});

test('approve rejects malformed, wrong and duplicate digests without changing state', () => {
  const { dir, id } = clean();
  assert.throws(() => approveAgentRun(dir, id, 'abc'), /64-character/);
  assert.throws(() => approveAgentRun(dir, id, '0'.repeat(64)), /Stale or wrong digest/);
  assert.equal(status(dir, id), 'WAITING_FOR_OWNER');
  approveAgentRun(dir, id, snap(dir, id).current_digest);
  assert.throws(() => approveAgentRun(dir, id, snap(dir, id).current_digest), /already approved/);
  assert.equal(evs(dir, id, 'owner_approval').length, 1);
});

test('approve is blocked while any blocker lacks an explicit owner decision', () => {
  const { dir, id } = blocked();
  const s = snap(dir, id);
  assert.deepEqual(s.blockers, ['claim:c03', 'craft:1']);
  assert.throws(() => approveAgentRun(dir, id, s.current_digest), /no owner decision for claim:c03, craft:1/);
  assert.throws(() => approveAgentRun(dir, id, s.current_digest, decisions(dir, { 'claim:c03': { decision: 'owner_attests', reason: 'I attended the meeting.' } })), /no owner decision for craft:1/);
  assert.equal(status(dir, id), 'WAITING_FOR_OWNER'); assert.equal(evs(dir, id, 'owner_approval').length, 0);
});

test('approval refuses a blocker record modified after review', () => {
  const { dir, id } = blocked(); const s = snap(dir, id);
  writeFileSync(art(dir, id, 'blockers-v001.json'), JSON.stringify({ blockers: [] }));
  assert.throws(() => approveAgentRun(dir, id, s.current_digest), /Recorded artifact changed/);
  assert.equal(status(dir, id), 'WAITING_FOR_OWNER');
});

test('revision refuses modified draft data before passing it to a model', () => {
  const { dir, id } = clean();
  const draftPath = art(dir, id, 'draft-v001.json');
  const d = json(draftPath); d.draft_markdown += '\nPRIVATE-INJECTED-SENTINEL-7751'; writeFileSync(draftPath, JSON.stringify(d));
  const feedback = join(dir, 'feedback.md'); writeFileSync(feedback, 'Clarify the ending.');
  const model = new FixtureModel(script());
  assert.throws(() => reviseAgentRun(dir, id, feedback, { model }), /Recorded artifact changed/);
  assert.equal(model.calls.length, 0);
});

test('approve rejects decisions of the wrong kind, unknown blocker IDs and empty reasons', () => {
  const { dir, id } = blocked(); const d = snap(dir, id).current_digest;
  const ok = { 'claim:c03': { decision: 'owner_attests', reason: 'Committee minutes confirm it.' }, 'craft:1': { decision: 'accepted_editorial_risk', reason: 'Flat ending is deliberate.' } };
  assert.throws(() => approveAgentRun(dir, id, d, decisions(dir, { ...ok, 'claim:c03': { decision: 'disclosure_approved', reason: 'Committee minutes confirm it.' } })), /not allowed for claim:c03/);
  assert.throws(() => approveAgentRun(dir, id, d, decisions(dir, { ...ok, 'claim:c99': { decision: 'owner_attests', reason: 'x'.repeat(12) } })), /not open on v001: claim:c99/);
  assert.throws(() => approveAgentRun(dir, id, d, decisions(dir, { ...ok, 'craft:1': { decision: 'accepted_editorial_risk', reason: 'ok' } })), /reason of at least 10/);
  assert.equal(status(dir, id), 'WAITING_FOR_OWNER');
});

test('approve with explicit decisions records them, and "before publication" decisions become conditions', () => {
  const { dir, id } = blocked(); const d = snap(dir, id).current_digest;
  const out = approveAgentRun(dir, id, d, decisions(dir, { 'claim:c03': { decision: 'remove_before_publication', reason: 'Not confirmed yet; cut it.' }, 'craft:1': { decision: 'accepted_editorial_risk', reason: 'Flat ending is deliberate.' } })) as any;
  assert.deepEqual(out.conditions, ['claim:c03']);
  const a = json(art(dir, id, 'approval-v001.json'));
  assert.equal(a.decisions['craft:1'].decision, 'accepted_editorial_risk');
  assert.match(snap(dir, id).next_action, /with conditions \(claim:c03\)/);
});

test('revising an approved run invalidates the approval; the old digest cannot approve the new version', () => {
  const { dir, req } = ws();
  const model = new FixtureModel(script({ writer: (_r, n) => JSON.stringify(n === 1 ? draft() : draft({}, DRAFT.replace('this issue will not pretend there is.', 'this issue says so.'))) }));
  const id = (startAgentRun(dir, req, { model }) as any).run_id as string;
  const d1 = snap(dir, id).current_digest;
  approveAgentRun(dir, id, d1);
  const fb = join(dir, 'fb.md'); writeFileSync(fb, 'Shorten the ending.');
  const rev = reviseAgentRun(dir, id, fb, { model }) as any;
  assert.equal(rev.version, 'v002'); assert.equal(status(dir, id), 'WAITING_FOR_OWNER');
  assert.equal(evs(dir, id, 'approval_invalidated').length, 1);
  const s = snap(dir, id);
  assert.equal(s.approved_digest, null);
  assert.throws(() => approveAgentRun(dir, id, d1), /Stale or wrong digest/);
  assert.equal((approveAgentRun(dir, id, s.current_digest) as any).version, 'v002');
  assert.equal(json(art(dir, id, 'approval-v001.json')).digest, d1); // history kept
});

test('approve refuses tampered draft bytes and sources changed after review', () => {
  const a = clean(); const d = snap(a.dir, a.id).current_digest;
  appendFileSync(art(a.dir, a.id, 'draft-v001.md'), '\nEdited by hand.');
  assert.throws(() => approveAgentRun(a.dir, a.id, d), /do not match the recorded digest/);
  const b = clean();
  appendFileSync(join(b.dir, 'sources/committee-decision.md'), '\nLate update.');
  assert.throws(() => approveAgentRun(b.dir, b.id, snap(b.dir, b.id).current_digest), /Sources changed since review/);
});

test('approve only from WAITING_FOR_OWNER: a BLOCKED_EVIDENCE run cannot be approved', () => {
  const { dir, req } = ws();
  const out = startAgentRun(dir, req, { model: new FixtureModel(script({ director: () => JSON.stringify({ decision: 'insufficient_evidence', reason: 'No outcome data.' }) })) }) as any;
  assert.throws(() => approveAgentRun(dir, out.run_id, 'a'.repeat(64)), /Only WAITING_FOR_OWNER/);
});

test('cancel: terminal CANCELLED; resume, revise, approve and a second cancel are all refused', () => {
  const { dir, id, model } = clean();
  const d = snap(dir, id).current_digest;
  assert.equal((cancelAgentRun(dir, id, 'owner changed topic') as any).status, 'CANCELLED');
  assert.equal(snap(dir, id).state, 'CANCELLED');
  const calls = model.calls.length;
  assert.throws(() => resumeAgentRun(dir, id, { model }), /cancelled/);
  const fb = join(dir, 'fb.md'); writeFileSync(fb, 'Try again please.');
  assert.throws(() => reviseAgentRun(dir, id, fb, { model }), /to revise/);
  assert.throws(() => approveAgentRun(dir, id, d), /Only WAITING_FOR_OWNER/);
  assert.throws(() => cancelAgentRun(dir, id, 'again'), /already cancelled/);
  assert.equal(model.calls.length, calls);
});

test('cancel a FAILED_RECOVERABLE run without any model call; approved runs cannot be cancelled; a reason is required', () => {
  const a = ws();
  assert.throws(() => startAgentRun(a.dir, a.req, { model: new FixtureModel(script({ writer: () => { throw new Error('outage'); } })) }));
  const failedId = listRuns(a.dir)[0].run_id;
  assert.equal(status(a.dir, failedId), 'FAILED_RECOVERABLE');
  const before = inspectRun(a.dir, failedId).calls;
  assert.equal((cancelAgentRun(a.dir, failedId, 'provider outage; dropping this idea') as any).from, 'FAILED_RECOVERABLE');
  assert.equal(inspectRun(a.dir, failedId).calls, before);
  assert.throws(() => resumeAgentRun(a.dir, failedId, { model: new FixtureModel(script()) }), /cancelled/);
  const { dir, id } = clean();
  assert.throws(() => cancelAgentRun(dir, id, ''), /needs a reason/);
  approveAgentRun(dir, id, snap(dir, id).current_digest);
  assert.throws(() => cancelAgentRun(dir, id, 'too late'), /Approved runs are terminal/);
});

test('cancel refuses while another process holds the workspace lock', () => {
  const { dir, id } = clean();
  const lock = join(dir, '.studio/runner.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'held-by-test', started: new Date().toISOString() }));
  try { assert.throws(() => cancelAgentRun(dir, id, 'stop it'), /already executing/); }
  finally { unlinkSync(lock); }
  assert.equal(status(dir, id), 'WAITING_FOR_OWNER');
});

test('handoff check: a reader given only the two portable files is scored field by field; state is unchanged', () => {
  const { dir, id } = blocked();
  const expected = expectedHandoff(snap(dir, id));
  const seen: string[] = [];
  const good = new FixtureModel((req) => { seen.push(req.prompt); return JSON.stringify({ ...expected, next_action: 'owner review', owner_must_decide: ['claim:c03', 'craft:1'] }); });
  const ok = handoffCheck(dir, id, 'fixture', { model: good }) as any;
  assert.equal(ok.all_pass, true); assert.equal(ok.live, false);
  assert.ok(!seen[0].includes('<source ') && !seen[0].includes('Volunteer log')); // no sources, no DB, no chat
  const stale = new FixtureModel(() => JSON.stringify({ ...expected, current_version: 'v000', blocker_ids: ['claim:c03'] }));
  const bad = handoffCheck(dir, id, 'fixture', { model: stale }) as any;
  assert.equal(bad.all_pass, false); assert.equal(bad.fields.current_version, false); assert.equal(bad.fields.blocker_ids, false);
  assert.equal(status(dir, id), 'WAITING_FOR_OWNER');
  assert.equal(evs(dir, id, 'handoff_check').length, 2);
});

test('external handoff: the printed prompt carries only the two files, and a pasted answer is scored deterministically', () => {
  const { dir, id } = blocked();
  const p = handoffPromptFor(dir, id);
  assert.match(p.user, /<file name="run-snapshot.json">/); assert.ok(!p.user.includes('<source '));
  const ans = join(dir, 'answer.json');
  writeFileSync(ans, '```json\n' + JSON.stringify({ ...expectedHandoff(snap(dir, id)), next_action: 'x', owner_must_decide: [] }) + '\n```');
  assert.equal((handoffScoreFile(dir, id, ans) as any).all_pass, true);
  writeFileSync(ans, JSON.stringify({ ...expectedHandoff(snap(dir, id)), state: 'ASSET_APPROVED' }));
  const r = handoffScoreFile(dir, id, ans) as any;
  assert.equal(r.all_pass, false); assert.equal(r.fields.state, false);
});
