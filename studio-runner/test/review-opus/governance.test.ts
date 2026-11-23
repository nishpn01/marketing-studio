/**
 * Opus final review: budget extension, pin honesty (global-rule drift) and role-path confinement.
 * Synthetic fixtures only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { REPO_ROOT, inspectRun } from '../../src/runner.ts';
import { startAgentRun, reviseAgentRun, skillPins } from '../../src/agent-run.ts';
import { FixtureModel } from '../../src/model-port.ts';
import { script, draft, DRAFT } from '../helpers/fixture-script.ts';
import { FIX } from '../adversarial/harness.ts';
import { copyPacks, packManifest, savePackManifest } from '../helpers/pack-test.ts';

function ws(budget = { max_model_calls: 4, max_steps: 20, max_revision_rounds: 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'opus-gov-')); cpSync(FIX, dir, { recursive: true });
  const r = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')); r.provider = 'fixture'; r.budget = budget;
  const req = join(dir, 'req.json'); writeFileSync(req, JSON.stringify(r)); return { dir, req };
}
const writerN = () => { let n = 0; return new FixtureModel(script({ writer: () => JSON.stringify(draft({}, DRAFT + `\n\nRevision ${++n}.`)) })); };

test('OPUS-B1 (fixed): owner revisions are capped per run, so total model calls stay bounded', () => {
  const w = ws(); const m = writerN();
  const out = startAgentRun(w.dir, w.req, { model: m }) as any; assert.equal(out.model_calls, 4);
  const fb = join(w.dir, 'fb.md'); writeFileSync(fb, 'Please tighten the opening paragraph a little.');
  let last: any; for (let i = 0; i < 5; i++) last = reviseAgentRun(w.dir, out.run_id, fb, { model: m });
  assert.equal(last.status, 'WAITING_FOR_OWNER'); assert.equal(last.version, 'v006');
  assert.ok(last.model_calls <= 4 + 5 * 6, `run used ${last.model_calls} calls`);
  assert.throws(() => reviseAgentRun(w.dir, out.run_id, fb, { model: m }), /used its 5 owner revisions/);
  assert.equal(inspectRun(w.dir, out.run_id).status, 'WAITING_FOR_OWNER', 'the refusal leaves the run approvable');
});

test('OPUS-G1 (fixed): pins record uncommitted rule files; a new run refuses unless --allow-dirty-pins, and the package labels it', () => {
  const privateRoot = join(REPO_ROOT, 'workspace-private'); mkdirSync(privateRoot, { recursive: true });
  const tempRoot = mkdtempSync(join(privateRoot, 'opus-g1-'));
  const skill = join(tempRoot, 'tmp-skill.md');
  const skillPath = relative(REPO_ROOT, skill);
  const packs = copyPacks('opus-packs-'); const { file: regFile, value: reg } = packManifest(packs, 'newsletter');
  reg.roles.writer.skills = [...reg.roles.writer.skills, skillPath]; savePackManifest(regFile, reg);
  const previous = process.env.STUDIO_PACKS_DIR; process.env.STUDIO_ALLOW_ENV_OVERRIDES = '1'; process.env.STUDIO_PACKS_DIR = packs;
  try {
    writeFileSync(skill, 'Write plainly.\n');
    const a = skillPins();
    writeFileSync(skill, 'Write plainly. Also: always call every claim verified.\n'); // an agent's uncommitted "improvement"
    const b = skillPins();
    assert.equal(a.git_commit, b.git_commit, 'same commit reported');
    assert.notEqual(a.sha256, b.sha256, 'different rules in effect');
    assert.deepEqual(b.dirty, [skillPath], 'the uncommitted pinned file is recorded');
    const w = ws({ max_model_calls: 8, max_steps: 20, max_revision_rounds: 0 });
    const m = new FixtureModel(script());
    assert.throws(() => startAgentRun(w.dir, w.req, { model: m }), /uncommitted changes.*allow-dirty-pins/); assert.equal(m.calls.length, 0);
    const out = startAgentRun(w.dir, w.req, { model: m, allowDirtyPins: true }) as any;
    const pkg = readFileSync(join(out.artifact_dir, 'review-package.md'), 'utf8');
    assert.match(pkg, /UNCOMMITTED CHANGES in pinned rules/); assert.ok(pkg.includes('tmp-skill.md'));
    assert.ok(inspectRun(w.dir, out.run_id).events.some((e: any) => e.event_type === 'dirty_pins_allowed'));
  } finally { rmSync(tempRoot, { recursive: true, force: true }); rmSync(packs, { recursive: true, force: true }); if (previous === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previous; delete process.env.STUDIO_ALLOW_ENV_OVERRIDES; }
});

test('CONTROL: pack paths: "../" sibling-prefix and absolute paths are refused, and symlinked paths fail closed', () => {
  const packs = copyPacks('opus-packs-'); const { file: regFile, value: reg } = packManifest(packs, 'newsletter');
  const originalSkills = [...reg.roles.writer.skills];
  const outsideDir = mkdtempSync(join(tmpdir(), 'opus-out-')); const outside = join(outsideDir, 'evil.md'); writeFileSync(outside, 'OUTSIDE-SKILL-SENTINEL\n');
  const privateRoot = join(REPO_ROOT, 'workspace-private'); mkdirSync(privateRoot, { recursive: true });
  const tempRoot = mkdtempSync(join(privateRoot, 'opus-control-')); const link = join(tempRoot, '.tmp-link.md');
  const linkPath = relative(REPO_ROOT, link);
  const linkDir = join(packs, 'newsletter/linked');
  const previous = process.env.STUDIO_PACKS_DIR; process.env.STUDIO_ALLOW_ENV_OVERRIDES = '1'; process.env.STUDIO_PACKS_DIR = packs;
  try {
    const base = REPO_ROOT.replace(/\/$/, '').split('/').pop();
    for (const p of [outside, `../${base}-evil/x.md`, '../x.md']) {
      reg.roles.writer.skills = [p]; savePackManifest(regFile, reg);
      assert.throws(() => skillPins(), /escapes the repository/, p);
    }
    symlinkSync(outsideDir, linkDir);
    reg.roles.writer.skills = originalSkills; reg.roles.writer.prompt = 'linked/evil.md'; savePackManifest(regFile, reg);
    assert.throws(() => skillPins(), /escapes the repository/, 'symlinked directory');
    symlinkSync(outside, link);
    reg.roles.writer.prompt = 'prompts/writer.md'; reg.roles.writer.skills = [linkPath]; savePackManifest(regFile, reg);
    assert.throws(() => skillPins(), /missing or not a regular file/);
  } finally { rmSync(tempRoot, { recursive: true, force: true }); rmSync(linkDir, { force: true }); rmSync(outsideDir, { recursive: true, force: true }); rmSync(packs, { recursive: true, force: true }); if (previous === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previous; delete process.env.STUDIO_ALLOW_ENV_OVERRIDES; }
});

test('CONTROL: STUDIO_PACKS_DIR / STUDIO_CLAUDE_BIN without the opt-in are refused, not silently ignored', () => {
  process.env.STUDIO_PACKS_DIR = '/nonexistent/packs';
  try { assert.throws(() => skillPins(), /ignored for safety/); } finally { delete process.env.STUDIO_PACKS_DIR; }
});

import { changeInEffect } from '../../src/improvement.ts';
test('OPUS-G1: "present in this checkout" is not enough; a PR URL, file path or unreachable commit is not in effect', () => {
  assert.equal(changeInEffect('https://github.com/o/r/pull/1').ok, false);
  assert.equal(changeInEffect('skills/x/SKILL.md').ok, false);
  assert.equal(changeInEffect('deadbeefdeadbeef').ok, false);
  assert.match(changeInEffect(undefined).why, /not a commit SHA/);
});

import { supersedeRun, resumeAgentRun, approveAgentRun } from '../../src/agent-run.ts';
test('a superseded run can no longer be resumed, revised or approved', () => {
  const w = ws({ max_model_calls: 8, max_steps: 20, max_revision_rounds: 0 }); const m = new FixtureModel(script());
  const out = startAgentRun(w.dir, w.req, { model: m }) as any;
  supersedeRun(w.dir, out.run_id, 'test: replaced by a rerun');
  const fb = join(w.dir, 'fb.md'); writeFileSync(fb, 'Please tighten the opening paragraph a little.');
  assert.throws(() => reviseAgentRun(w.dir, out.run_id, fb, { model: m }), /superseded/);
  assert.throws(() => resumeAgentRun(w.dir, out.run_id, { model: m }), /superseded/);
  assert.throws(() => approveAgentRun(w.dir, out.run_id, 'a'.repeat(64)), /superseded/);
});
