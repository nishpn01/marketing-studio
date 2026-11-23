/** Independent review: Newsletter and Conversion Copywriting packs end to end, and a third pack without Runner source changes. */
process.env.STUDIO_ALLOW_ENV_OVERRIDES = '1'; process.env.STUDIO_ALLOW_OUTSIDE_ROLE_PATHS = '1';
import test from 'node:test';
import { ClaudeCodeCliModel } from '../../src/model-port.ts';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentRun, reviseAgentRun, validateSpecialist, skillPins } from '../../src/agent-run.ts';
import { loadPack } from '../../src/pack-loader.ts';
import { sessionStart, evidenceAddHost, directionApprove, sessionRun } from '../../src/director-session.ts';
import { REPO_ROOT } from '../../src/runner.ts';
import { FixtureModel } from '../../src/model-port.ts';
import { script, brief, draft, facts, craft } from '../helpers/fixture-script.ts';
import { bizWs, editBiz, direction, FIX } from '../adversarial/harness.ts';
import { copyPacks, packManifest, savePackManifest } from '../helpers/pack-test.ts';

const roles = { roles: loadPack('newsletter').roles, specialists: { 'conversion-copywriting': { roles: loadPack('conversion-copywriting').roles } } };
const MARK = 'THIRD-SPECIALIST-SKILL-MARKER-5150';
const sysOf = (m: FixtureModel, role: string) => m.calls.find(c => c.role === role)!.system;
const body = '# A simple task list\n\nDayboard is available as a local preview. Arrange your personal tasks in one list and explore the preview at your own pace.';
function conversionModel() {
  return new FixtureModel(script({
    director: () => JSON.stringify(brief({ reader_question: 'What can the preview do?', angle: 'A small personal task list', reader_promise: 'Understand the preview', alternatives_considered: [{ angle: 'Guaranteed results', why_not: 'No results exist.' }, { angle: 'Testimonials', why_not: 'None documented.' }], exclusions: [], open_questions_for_owner: [], evidence_plan: [{ point: 'preview', source_ids: ['src_1'] }] })),
    writer: () => JSON.stringify(draft({ title: 'A simple task list', claims: [{ id: 'c01', text: 'Dayboard is available as a local preview.', draft_quote: 'Dayboard is available as a local preview.', source_ids: ['src_1'] }] }, body)),
    fact_reviewer: () => JSON.stringify(facts([{ claim_id: 'c01', verdict: 'verified', source_id: 'src_1', source_excerpt: 'Dayboard is available as a local preview.' }])),
    craft_reviewer: () => JSON.stringify(craft({ strengths: [{ excerpt: 'Dayboard is available as a local preview.', why: 'Specific.' }] })),
  }));
}
function conversionWs(specialist?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'rev-spec-')); cpSync(join(REPO_ROOT, 'studio-runner/fixtures/agent-sample'), dir, { recursive: true });
  writeFileSync(join(dir, 'sources/volunteer-log.md'), 'Fictional product source: Dayboard is available as a local preview. It lets a user arrange a small list of personal tasks. No customer outcomes have been measured.');
  const r = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')); r.provider = 'fixture'; r.idea = 'Create a landing-page draft for the fictional Dayboard preview.'; if (specialist) r.pack_id = specialist;
  const p = join(dir, 'req.json'); writeFileSync(p, JSON.stringify(r)); return { dir, p };
}

test('Newsletter (default) end to end: correct role skills, no copywriting-specialist leakage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-news-')); cpSync(FIX, dir, { recursive: true });
  const r = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')); r.provider = 'fixture'; writeFileSync(join(dir, 'req.json'), JSON.stringify(r));
  const m = new FixtureModel(script()); const out: any = startAgentRun(dir, join(dir, 'req.json'), { model: m });
  assert.equal(out.status, 'WAITING_FOR_OWNER');
  for (const [role, def] of Object.entries<any>(roles.roles)) for (const s of def.skills) assert.ok(sysOf(m, role).includes(`<skill path="${s}">`), `${role} lacks ${s}`);
  for (const role of ['director', 'writer', 'fact_reviewer', 'craft_reviewer']) assert.ok(!sysOf(m, role).includes('specialists/copywriting'), `${role} got copywriting specialist skills`);
});

test('Conversion Copywriting end to end: every role receives exactly its specialist skills; fact_reviewer falls back to the shared gate contract', () => {
  const { dir, p } = conversionWs('conversion-copywriting'); const m = conversionModel();
  const out: any = startAgentRun(dir, p, { model: m }); assert.equal(out.status, 'WAITING_FOR_OWNER'); assert.equal(out.live, false);
  const spec = roles.specialists['conversion-copywriting'].roles;
  for (const role of ['director', 'writer', 'craft_reviewer'] as const) {
    for (const s of spec[role].skills) assert.ok(sysOf(m, role).includes(`<skill path="${s}">`), `${role} lacks ${s}`);
    assert.ok(!sysOf(m, role).includes('<skill path="specialists/newsletter/'), `${role} still gets newsletter specialist skills`);
  }
  for (const s of roles.roles.fact_reviewer.skills) assert.ok(sysOf(m, 'fact_reviewer').includes(`<skill path="${s}">`));
});

test('A fixture pack registers through STUDIO_PACKS_DIR alone (no source change) and is pinned per run', () => {
  const tmp = copyPacks('rev-packs-');
  const skill = join(tmp, 'THIRD-SKILL.md'); writeFileSync(skill, `# Third specialist skill\n${MARK}\n`);
  cpSync(join(tmp, 'conversion-copywriting'), join(tmp, 'launch-emails'), { recursive: true });
  const { file: rf, value: reg } = packManifest(tmp, 'launch-emails'); reg.id = 'launch-emails';
  reg.roles.director.skills = ['core/DIRECTOR.md', skill]; reg.roles.writer.skills = [skill, 'skills/copywriting/MESSAGE-CRAFT.md']; reg.roles.craft_reviewer.skills = ['specialists/copywriting/QUALITY.md']; savePackManifest(rf, reg);
  assert.throws(() => validateSpecialist('launch-emails'), /Unknown specialist/, 'not visible without the override');
  const previous = process.env.STUDIO_PACKS_DIR; process.env.STUDIO_PACKS_DIR = tmp;
  try {
    validateSpecialist('launch-emails');
    const { dir, p } = conversionWs('launch-emails'); const m = conversionModel();
    const out: any = startAgentRun(dir, p, { model: m }); assert.equal(out.status, 'WAITING_FOR_OWNER');
    assert.ok(sysOf(m, 'writer').includes(MARK) && sysOf(m, 'director').includes(MARK));
    assert.ok(!sysOf(m, 'craft_reviewer').includes(MARK) && !sysOf(m, 'fact_reviewer').includes(MARK));
    // the Director session flow accepts it too
    const b = bizWs(); sessionStart(b.ws, 'A synthetic launch email idea long enough', 'third-sess');
    evidenceAddHost(b.ws, 'third-sess', { kind: 'web', uri: 'https://example.org/x', file: join(dir, 'sources/volunteer-log.md'), retrieved_by: 'claude-code:WebFetch' });
    directionApprove(b.ws, 'third-sess', direction(b.ws, { specialist: 'launch-emails' }));
    // pinned: editing the skill after review blocks a revise (R10)
    writeFileSync(skill, `# Third specialist skill\nCHANGED\n`);
    const fb = join(dir, 'fb.md'); writeFileSync(fb, 'Please tighten the opening paragraph.');
    assert.throws(() => reviseAgentRun(dir, out.run_id, fb, { model: conversionModel() }), /pinned skills changed/);
    // validation: incomplete or out-of-range definitions are refused
    cpSync(join(tmp, 'launch-emails'), join(tmp, 'bad-roles'), { recursive: true }); const badRoles = packManifest(tmp, 'bad-roles'); badRoles.value.id = 'bad-roles'; delete badRoles.value.roles.fact_reviewer; savePackManifest(badRoles.file, badRoles.value);
    cpSync(join(tmp, 'launch-emails'), join(tmp, 'bad-min'), { recursive: true }); const badMin = packManifest(tmp, 'bad-min'); badMin.value.id = 'bad-min'; badMin.value.gates.min_draft_words = 0; savePackManifest(badMin.file, badMin.value);
    assert.throws(() => validateSpecialist('bad-roles'), /Invalid capability pack/);
    assert.throws(() => validateSpecialist('bad-min'), /Invalid capability pack/);
    assert.throws(() => validateSpecialist('__proto__'), /Unknown specialist/);
    assert.notEqual(skillPins('conversion-copywriting').sha256, skillPins().sha256);
  } finally { if (previous === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previous; rmSync(tmp, { recursive: true, force: true }); }
});

test('F-PACKS-1: pack paths are confined to the repo unless explicitly opted in', () => {
  const tmp = copyPacks('rev-packs2-'); const outside = join(tmp, 'outside.md'); writeFileSync(outside, 'OUTSIDE-PACK-INSTRUCTIONS');
  const { file: rf, value: reg } = packManifest(tmp, 'newsletter'); reg.roles.writer.skills = [outside]; savePackManifest(rf, reg); const previous = process.env.STUDIO_PACKS_DIR; process.env.STUDIO_PACKS_DIR = tmp;
  const keep = process.env.STUDIO_ALLOW_OUTSIDE_ROLE_PATHS, keepAll = process.env.STUDIO_ALLOW_ENV_OVERRIDES;
  try {
    delete process.env.STUDIO_ALLOW_OUTSIDE_ROLE_PATHS;
    assert.throws(() => skillPins(), /escapes the repository/);
    reg.roles.writer.skills = ['../outside.md']; savePackManifest(rf, reg);
    assert.throws(() => skillPins(), /escapes the repository/);
    process.env.STUDIO_ALLOW_OUTSIDE_ROLE_PATHS = '1'; reg.roles.writer.skills = [outside]; savePackManifest(rf, reg);
    assert.equal(skillPins().roles.writer.skills.length, 1, 'explicit opt-in still works');
    delete process.env.STUDIO_ALLOW_ENV_OVERRIDES;
    assert.throws(() => skillPins(), /STUDIO_ALLOW_ENV_OVERRIDES/);
    process.env.STUDIO_CLAUDE_BIN = '/tmp/evil-bin';
    assert.throws(() => new ClaudeCodeCliModel(), /STUDIO_ALLOW_ENV_OVERRIDES/);
  } finally {
    if (previous === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previous; delete process.env.STUDIO_CLAUDE_BIN; rmSync(tmp, { recursive: true, force: true });
    if (keep) process.env.STUDIO_ALLOW_OUTSIDE_ROLE_PATHS = keep; if (keepAll) process.env.STUDIO_ALLOW_ENV_OVERRIDES = keepAll;
  }
});
void editBiz; void sessionRun;
