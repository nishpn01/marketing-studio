process.env.STUDIO_ALLOW_ENV_OVERRIDES = '1'; process.env.STUDIO_ALLOW_OUTSIDE_ROLE_PATHS = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startAgentRun, resumeAgentRun, reviseAgentRun, approveAgentRun, validateAgentRequest, skillPins } from '../src/agent-run.ts';
import { listRuns, REPO_ROOT } from '../src/runner.ts';
import { FixtureModel } from '../src/model-port.ts';
import { script, brief, draft, facts, craft } from './helpers/fixture-script.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'studio-conversion-'));
  cpSync(join(REPO_ROOT, 'studio-runner/fixtures/agent-sample'), dir, { recursive: true });
  const requestPath = join(dir, 'request.json');
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  request.provider = 'fixture'; request.pack_id = 'conversion-copywriting';
  request.idea = 'Create a landing-page draft for the fictional Dayboard preview.';
  writeFileSync(join(dir, 'sources/volunteer-log.md'), 'Fictional product source: Dayboard is available as a local preview. It lets a user arrange a small list of personal tasks. No customer outcomes have been measured.');
  writeFileSync(requestPath, JSON.stringify(request));
  return { dir, requestPath, request };
}
const text = '# A simple task list\n\nDayboard is available as a local preview. Arrange your personal tasks in one list and explore the preview at your own pace.';
function model() {
  return new FixtureModel(script({
    director: () => JSON.stringify(brief({ reason: 'The fictional source documents a preview.', reader_question: 'What can the preview do?', angle: 'A small personal task list', reader_promise: 'Understand the preview', alternatives_considered: [{ angle: 'Guaranteed results', why_not: 'No results exist.' }, { angle: 'Customer testimonials', why_not: 'No customers are documented.' }], exclusions: ['No invented outcomes'], open_questions_for_owner: [], evidence_plan: [{ point: 'preview availability', source_ids: ['src_1'] }] })),
    writer: (_req, n) => JSON.stringify(draft({ title: 'A simple task list', claims: [{ id: 'c01', text: 'Dayboard is available as a local preview.', draft_quote: 'Dayboard is available as a local preview.', source_ids: ['src_1'] }] }, text + (n > 1 ? '\n\nThis draft remains under review.' : ''))),
    fact_reviewer: () => JSON.stringify(facts([{ claim_id: 'c01', verdict: 'verified', source_id: 'src_1', source_excerpt: 'Dayboard is available as a local preview.' }])),
    craft_reviewer: () => JSON.stringify(craft({ strengths: [{ excerpt: 'Dayboard is available as a local preview.', why: 'Specific offer status.' }] })),
  }));
}

test('conversion specialist executes through shared Runner, separate QA and exact-version owner gate', () => {
  const { dir, requestPath } = fixture(); const m = model();
  const out = startAgentRun(dir, requestPath, { model: m }) as any;
  assert.equal(out.status, 'WAITING_FOR_OWNER'); assert.equal(out.live, false);
  assert.deepEqual(m.calls.map(c => c.role), ['director', 'writer', 'fact_reviewer', 'craft_reviewer']);
  const sys = (role: string) => m.calls.find(c => c.role === role)!.system;
  assert.match(sys('writer'), /specialists\/copywriting\/AGENT.md/);
  assert.match(sys('writer'), /skills\/copywriting\/MESSAGE-CRAFT.md/);
  assert.doesNotMatch(sys('writer'), /specialists\/newsletter\/AGENT.md/);
  assert.match(sys('craft_reviewer'), /specialists\/copywriting\/QUALITY.md/);
  assert.match(sys('craft_reviewer'), /skills\/copywriting\/READER-EVALUATION.md/);
  assert.doesNotMatch(sys('fact_reviewer'), /skills\/copywriting/);
  const root = join(dir, '.studio/artifacts', out.run_id);
  const qa = JSON.parse(readFileSync(join(root, 'factual-qa-v001.json'), 'utf8'));
  assert.equal(qa.claims[0].verdict, 'verified');
  const craftQa = JSON.parse(readFileSync(join(root, 'craft-qa-v001.json'), 'utf8'));
  assert.match(craftQa.method, /conversion-copywriting/);
  const snap = JSON.parse(readFileSync(join(root, 'run-snapshot.json'), 'utf8'));
  assert.equal(snap.publication_authorized, false);
  const feedback = join(dir, 'feedback.md'); writeFileSync(feedback, 'Keep the evidence clear.');
  const revised = reviseAgentRun(dir, out.run_id, feedback, { model: m }) as any;
  assert.equal(revised.version, 'v002');
  const current = JSON.parse(readFileSync(join(root, 'run-snapshot.json'), 'utf8'));
  assert.throws(() => approveAgentRun(dir, out.run_id, snap.current_digest), /Stale or wrong digest/);
  const approved = approveAgentRun(dir, out.run_id, current.current_digest) as any;
  assert.equal(approved.status, 'ASSET_APPROVED'); assert.equal(approved.publication_authorized, false);
});

test('specialist selection is explicit, validated and changes pinned skills', () => {
  const { request } = fixture();
  assert.throws(() => validateAgentRequest({ ...request, pack_id: 'not-registered' }), /Unknown specialist/);
  assert.notEqual(skillPins().sha256, skillPins('conversion-copywriting').sha256);
  assert.ok(skillPins('conversion-copywriting').roles.writer.skills.some(s => s.path === 'specialists/copywriting/AGENT.md'));
});

test('specialist configuration drift blocks resuming interrupted runs', () => {
  const { dir, requestPath } = fixture(); const packs = mkdtempSync(join(tmpdir(), 'studio-pack-drift-')); mkdirSync(join(packs, 'conversion-copywriting'));
  cpSync(join(REPO_ROOT, 'packs/conversion-copywriting'), join(packs, 'conversion-copywriting'), { recursive: true });
  cpSync(join(REPO_ROOT, 'packs/shared'), join(packs, 'shared'), { recursive: true });
  const manifest = join(packs, 'conversion-copywriting/pack.json'); const value = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const [role, def] of Object.entries<any>(value.roles)) if (role !== 'fact_reviewer') def.skills = def.skills.map((p: string) => resolve(REPO_ROOT, p));
  writeFileSync(manifest, JSON.stringify(value));
  const previous = process.env.STUDIO_PACKS_DIR; process.env.STUDIO_PACKS_DIR = packs;
  try {
    const down = new FixtureModel(script({ writer: () => { throw new Error('fixture outage'); } }));
    assert.throws(() => startAgentRun(dir, requestPath, { model: down }), /fixture outage/);
    value.gates.min_draft_words = 21; writeFileSync(manifest, JSON.stringify(value));
    assert.throws(() => resumeAgentRun(dir, listRuns(dir)[0].run_id, { model: model() }), /pinned skills changed/);
  } finally { if (previous === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previous; rmSync(packs, { recursive: true, force: true }); }
});

test('specialist configuration drift during a run blocks the next model call', () => {
  const { dir, requestPath } = fixture(); const packs = mkdtempSync(join(tmpdir(), 'studio-pack-drift-')); mkdirSync(join(packs, 'conversion-copywriting'));
  cpSync(join(REPO_ROOT, 'packs/conversion-copywriting'), join(packs, 'conversion-copywriting'), { recursive: true });
  cpSync(join(REPO_ROOT, 'packs/shared'), join(packs, 'shared'), { recursive: true });
  const manifest = join(packs, 'conversion-copywriting/pack.json'); const value = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const [role, def] of Object.entries<any>(value.roles)) if (role !== 'fact_reviewer') def.skills = def.skills.map((p: string) => resolve(REPO_ROOT, p));
  writeFileSync(manifest, JSON.stringify(value));
  const previous = process.env.STUDIO_PACKS_DIR; process.env.STUDIO_PACKS_DIR = packs;
  try {
    const m = new FixtureModel(script({ director: () => {
      value.gates.min_draft_words = 21; writeFileSync(manifest, JSON.stringify(value));
      return JSON.stringify(brief());
    } }));
    assert.throws(() => startAgentRun(dir, requestPath, { model: m }), /pinned skills changed/);
    assert.deepEqual(m.calls.map(c => c.role), ['director']);
  } finally { if (previous === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previous; rmSync(packs, { recursive: true, force: true }); }
});
