import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sessionStart, evidenceAddCatalog, directionApprove, sessionRun, sessionRerun, loadSession } from '../src/director-session.ts';
import { improvementPropose, improvementHandoff, improvementRecord, improvementDecide, improvementClose, improvementList, classify } from '../src/improvement.ts';
import { reviseAgentRun } from '../src/agent-run.ts';
import { REPO_ROOT } from '../src/runner.ts';
import { FixtureModel } from '../src/model-port.ts';
import { script, brief, draft, facts, DRAFT } from './helpers/fixture-script.ts';

function model() {
  const two = (ids: string[]) => ids.map(s => (s === 'src_3' ? 'src_2' : s));
  return new FixtureModel(script({
    director: () => JSON.stringify(brief({ evidence_plan: [{ point: 'p', source_ids: ['src_1'] }, { point: 'q', source_ids: ['src_2'] }] })),
    writer: (_r, n) => JSON.stringify(draft({ claims: draft().claims.map(c => ({ ...c, source_ids: two(c.source_ids) })) }, n === 1 ? DRAFT : DRAFT.replace('this issue will not pretend there is.', 'this issue says so plainly.'))),
    fact_reviewer: () => JSON.stringify(facts(facts().claims.map(c => ({ ...c, verdict: 'not_checked' })))),
  }));
}
/** A business workspace with one newsletter session already at WAITING_FOR_OWNER. */
function inReview() {
  const top = mkdtempSync(join(tmpdir(), 'imp-')); const ws = join(top, 'ws'), docs = join(top, 'docs');
  mkdirSync(ws); mkdirSync(docs); mkdirSync(join(ws, 'context'));
  writeFileSync(join(docs, 'notes.md'), '# Notes\n\n## Status\nThe status column mixed stage and outcome in one cell.\n');
  writeFileSync(join(docs, 'more.md'), '# More\n\nWe walked the process and corrected the map.\n');
  writeFileSync(join(ws, 'context', 'style.md'), 'First person.');
  writeFileSync(join(ws, 'studio-business.json'), JSON.stringify({ schema_version: 'studio.business/0.1', workspace_id: 'imp-test', vars: { D: docs }, allowed_roots: ['${D}'],
    defaults: { audience: 'teams', provider: 'claude-code-cli', models: { director: 's', writer: 's', fact_reviewer: 's', craft_reviewer: 's' }, budget: { max_model_calls: 12, max_steps: 40, max_revision_rounds: 0 } },
    catalog: [{ id: 'notes', path: '${D}/notes.md', visibility: 'approved', description: 'n' }, { id: 'more', path: '${D}/more.md', visibility: 'approved', description: 'm' }] }));
  sessionStart(ws, 'newsletter about status fields', 'status-issue');
  evidenceAddCatalog(ws, 'status-issue', 'notes'); evidenceAddCatalog(ws, 'status-issue', 'more');
  const d = join(top, 'd.json'); writeFileSync(d, JSON.stringify({ reader_question: 'Why does a status field matter?', angle: 'Walk the work first', reader_promise: 'Check one field', audience: 'teams', exclusions: [], approval: { type: 'owner', quote: 'Go with that angle.' } }));
  directionApprove(ws, 'status-issue', d);
  const run = sessionRun(ws, 'status-issue', { model: model() }) as any;
  return { ws, top, run };
}
function proposal(top: string, over: object = {}) {
  const p = join(top, `p-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ title: 'Provenance header leaks into copy', finding: 'The writer copied a source provenance line into the article text.', proposed_change: 'Render provenance as a labelled never-quote block in sourceBlock.',
    affected: ['core:studio-runner/src/agent-run.ts'], tests_required: ['Writer prompt never contains the raw provenance header', 'Regression on two different assets'],
    references: [{ kind: 'session_artifact', ref: 'craft-qa-v001.json' }], owner_request: 'Please investigate this leak and start a fix.', ...over }));
  return p;
}
const coreStatus = () => spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;

test('classification follows what the fix touches; mismatched or mixed scopes are refused', () => {
  assert.equal(classify(['core:studio-runner/src/agent-run.ts'], []), 'runner_code');
  assert.equal(classify(['core:skills/newsletter-craft/SKILL.md'], []), 'shared_method');
  assert.equal(classify(['core:packs/newsletter/prompts/writer.md'], []), 'shared_method');
  assert.equal(classify(['context/style.md'], []), 'business_guidance');
  assert.equal(classify(['catalog:notes'], ['notes']), 'business_knowledge');
  assert.equal(classify(['run:draft-v001.md'], []), 'asset');
  assert.equal(classify(['core:skills/x.md', 'context/style.md'], []), null);
  const { ws, top } = inReview();
  assert.throws(() => improvementPropose(ws, 'status-issue', proposal(top, { scope: 'asset' }), 'claude-code:marketing-director'), /affected\[\] implies "runner_code"/);
  assert.throws(() => improvementPropose(ws, 'status-issue', proposal(top, { affected: ['core:skills/a.md', 'context/style.md'] }), 'claude-code:x'), /mixes scopes/);
});

test('a proposal needs the owner\'s request, real references, and tests for global changes', () => {
  const { ws, top } = inReview();
  assert.throws(() => improvementPropose(ws, 'status-issue', proposal(top, { owner_request: '' }), 'claude-code:x'), /owner's own words/);
  assert.throws(() => improvementPropose(ws, 'status-issue', proposal(top, { references: [{ kind: 'session_artifact', ref: 'nope.json' }] }), 'claude-code:x'), /not found/);
  assert.throws(() => improvementPropose(ws, 'status-issue', proposal(top, { references: [{ kind: 'capture_item', ref: 'cap-000000000000#ci-1' }] }), 'claude-code:x'), /No capture/);
  assert.throws(() => improvementPropose(ws, 'status-issue', proposal(top, { tests_required: [] }), 'claude-code:x'), /tests_required/);
  assert.throws(() => improvementPropose(ws, 'status-issue', proposal(top), 'nobody'), /host:tool/);
});

test('file and run artifact references cannot follow symlinks outside their authorized roots', () => {
  const { ws, top, run } = inReview();
  const outside = join(top, 'other-tenant.txt');
  writeFileSync(outside, 'PRIVATE-OTHER-TENANT-SENTINEL');
  symlinkSync(outside, join(ws, 'outside-link'));
  assert.throws(() => improvementPropose(ws, 'status-issue', proposal(top, { references: [{ kind: 'file', ref: 'outside-link' }] }), 'claude-code:x'), /outside its permitted root/);
  symlinkSync(outside, join(ws, '.studio', 'artifacts', run.run_id, 'outside-link'));
  assert.throws(() => improvementPropose(ws, 'status-issue', proposal(top, { references: [{ kind: 'session_artifact', ref: 'outside-link' }] }), 'claude-code:x'), /outside its permitted root/);
});

test('full engineering loop: propose -> handoff brief -> record tested change -> owner approves -> close; the session and Core are untouched', () => {
  const { ws, top, run } = inReview();
  const before = loadSession(ws, 'status-issue'), core = coreStatus();
  const p = improvementPropose(ws, 'status-issue', proposal(top), 'claude-code:marketing-director') as any;
  assert.equal(p.scope, 'runner_code'); assert.equal(p.origin.run_id, run.run_id); assert.equal(p.origin.version, 'v001');
  assert.throws(() => improvementRecord(ws, p.id, 'https://github.com/o/r/pull/9', 'npm test => 80 pass'), /Issue the engineering handoff/);
  assert.throws(() => improvementDecide(ws, p.id, 'approve', 'Looks good'), /Only an implemented, tested change/);
  const h = improvementHandoff(ws, p.id, 'codex') as any;
  assert.equal(h.direct_invocation, 'not implemented');
  const brief = readFileSync(join(ws, h.handoff), 'utf8');
  for (const must of ['Do not merge', 'draft pull request', 'Regression on two different assets', 'improvement-record', 'Please investigate this leak', 'status-issue']) assert.ok(brief.includes(must), must);
  assert.throws(() => improvementRecord(ws, p.id, 'https://github.com/o/r/pull/9', 'ran tests'), /"<command> => <result>"/);
  improvementRecord(ws, p.id, 'https://github.com/o/r/pull/9', 'npm --prefix studio-runner test => 85 pass, 0 fail');
  assert.throws(() => improvementDecide(ws, p.id, 'approve', ''), /owner's own words/);
  assert.equal((improvementDecide(ws, p.id, 'approve', 'Looks good to me.') as any).effect, 'improvement decision recorded; merging requires separate owner authorization');
  const c = improvementClose(ws, p.id) as any;
  assert.equal(c.direction_unchanged, true); assert.match(c.next, /session-rerun --session status-issue/);
  const after = loadSession(ws, 'status-issue');
  assert.deepEqual(after.direction, before.direction); assert.equal(after.run_id, before.run_id); assert.equal(after.state, 'in_review');
  assert.equal(after.improvements!.find(x => x.id === p.id)!.status, 'closed');
  assert.equal(coreStatus(), core, 'no file in Core changed');
});

test('asset-scope flaws are fixed by revising this run, need a newer version, and get no engineering handoff', () => {
  const { ws, top, run } = inReview();
  const p = improvementPropose(ws, 'status-issue', proposal(top, { title: 'Ending sounds defensive', finding: 'The last sentence of this draft sounds defensive to the owner.', proposed_change: 'Revise the closing line only.', affected: ['run:draft-v001.md'], tests_required: [], references: [{ kind: 'session_artifact', ref: 'draft-v001.md' }] }), 'claude-code:x') as any;
  assert.equal(p.scope, 'asset');
  assert.throws(() => improvementHandoff(ws, p.id, 'claude-code'), /not by an engineering handoff/);
  assert.throws(() => improvementRecord(ws, p.id, 'draft-v001.md', '', 'v001'), /newer version/);
  const fb = join(top, 'fb.md'); writeFileSync(fb, 'Make the ending plain.');
  reviseAgentRun(ws, run.run_id, fb, { model: model() });
  assert.equal((improvementRecord(ws, p.id, 'draft-v002.md', '', 'v002') as any).status, 'implemented');
  improvementDecide(ws, p.id, 'approve', 'Better, thanks.');
  assert.match((improvementClose(ws, p.id) as any).next, /Continue reviewing v002/);
});

test('session-rerun continues the same newsletter (same direction and evidence) in a fresh run and keeps the old run; changed evidence blocks it', () => {
  const { ws, top, run } = inReview();
  assert.throws(() => sessionRerun(ws, 'status-issue', 'short', { model: model() }), /at least 10/);
  const out = sessionRerun(ws, 'status-issue', 'Runner fix approved; pins changed', { model: model() }) as any;
  assert.equal(out.status, 'WAITING_FOR_OWNER'); assert.notEqual(out.run_id, run.run_id);
  const s = loadSession(ws, 'status-issue');
  assert.deepEqual(s.previous_runs, [run.run_id]);
  assert.equal(JSON.parse(readFileSync(join(ws, 'sessions/status-issue/request.json'), 'utf8')).approved_direction.angle, 'Walk the work first');
  appendFileSync(join(ws, s.evidence[0].path), '\nedited'); assert.throws(() => sessionRerun(ws, 'status-issue', 'second rerun after edit', { model: model() }), /Evidence changed/);
  void top;
});

test('rejection closes without changes; improvements are isolated per workspace', () => {
  const a = inReview(), b = inReview();
  const p = improvementPropose(a.ws, 'status-issue', proposal(a.top), 'claude-code:x') as any;
  assert.equal((improvementDecide(a.ws, p.id, 'reject', 'Not a real flaw; the line was intended.') as any).status, 'rejected');
  assert.match((improvementClose(a.ws, p.id) as any).next, /Continue the newsletter as it was/);
  assert.equal(improvementList(b.ws).length, 0);
  assert.throws(() => improvementHandoff(b.ws, p.id, 'codex'), /No improvement/);
});

test('re-approving a direction on a session that has run supersedes the old run and direction, keeping both in history', () => {
  const { ws, top, run } = inReview();
  const d = join(top, 'd2.json'); writeFileSync(d, JSON.stringify({ reader_question: 'Why does a status field matter?', angle: 'Walk the work first, owner-approved', reader_promise: 'Check one field', audience: 'teams', exclusions: [], approval: { type: 'owner', quote: 'Yes, I approve that angle.' } }));
  assert.equal((directionApprove(ws, 'status-issue', d) as any).state, 'direction_approved');
  const s = loadSession(ws, 'status-issue');
  assert.deepEqual(s.previous_runs, [run.run_id]); assert.equal(s.run_id, null);
  assert.equal(s.previous_directions![0].approval.type, 'owner'); assert.equal(s.direction.angle, 'Walk the work first, owner-approved');
  assert.equal((sessionRun(ws, 'status-issue', { model: model() }) as any).status, 'WAITING_FOR_OWNER');
});
