import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, hash } from '../src/runner.ts';
import { loadPack, listPackIds } from '../src/pack-loader.ts';
import { resumeAgentRun, reviseAgentRun, startAgentRun, validateAgentRequest } from '../src/agent-run.ts';
import { FixtureModel } from '../src/model-port.ts';
import { script } from './helpers/fixture-script.ts';

test('built-in packs are strict and legacy omission maps explicitly to newsletter', () => {
  assert.deepEqual(listPackIds(), ['conversion-copywriting', 'newsletter']);
  assert.equal(loadPack('newsletter').pipeline, 'text-asset');
  assert.equal(loadPack('conversion-copywriting').roles.fact_reviewer.prompt, '../shared/fact-reviewer.md');
  const request = JSON.parse(readFileSync(join(REPO_ROOT, 'studio-runner/fixtures/agent-sample/request.json'), 'utf8'));
  const normalized = validateAgentRequest(request);
  assert.equal(normalized.pack_id, 'newsletter');
  assert.deepEqual(normalized.budget, loadPack('newsletter').budget_defaults);
});

test('fact review is loader-owned shared QA', () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-pack-shared-'));
  const previous = process.env.STUDIO_PACKS_DIR;
  const previousOptIn = process.env.STUDIO_ALLOW_ENV_OVERRIDES;
  cpSync(join(REPO_ROOT, 'packs'), root, { recursive: true });
  const manifest = join(root, 'newsletter/pack.json');
  const pack = JSON.parse(readFileSync(manifest, 'utf8'));
  pack.roles.fact_reviewer.prompt = 'prompts/fact-reviewer.md';
  writeFileSync(manifest, JSON.stringify(pack));
  process.env.STUDIO_ALLOW_ENV_OVERRIDES = '1'; process.env.STUDIO_PACKS_DIR = root;
  try { assert.throws(() => loadPack('newsletter'), /loader-owned shared QA/); }
  finally {
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previous;
    if (previousOptIn === undefined) delete process.env.STUDIO_ALLOW_ENV_OVERRIDES; else process.env.STUDIO_ALLOW_ENV_OVERRIDES = previousOptIn;
  }
});

test('pre-pack role pins remain resumable and revisable', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'studio-pack-legacy-'));
  cpSync(join(REPO_ROOT, 'studio-runner/fixtures/agent-sample'), workspace, { recursive: true });
  const requestPath = join(workspace, 'request.json');
  const request = JSON.parse(readFileSync(requestPath, 'utf8')); request.provider = 'fixture'; writeFileSync(requestPath, JSON.stringify(request));
  const first = startAgentRun(workspace, requestPath, { model: new FixtureModel(script()) }) as any;
  const db = new DatabaseSync(join(workspace, '.studio/runs.sqlite'));
  const event = db.prepare("SELECT details_json FROM events WHERE run_id=? AND event_type='skill_pins'").get(first.run_id) as { details_json: string };
  const legacy = JSON.parse(event.details_json); legacy.sha256 = hash(JSON.stringify(legacy.roles)); delete legacy.pack_id; delete legacy.pack_version; delete legacy.manifest_sha256; delete legacy.qa_rubric;
  db.prepare("UPDATE events SET details_json=? WHERE run_id=? AND event_type='skill_pins'").run(JSON.stringify(legacy), first.run_id);
  db.prepare("UPDATE runs SET status='BLOCKED_BUDGET' WHERE run_id=?").run(first.run_id); db.close();
  const resumed = resumeAgentRun(workspace, first.run_id, { model: new FixtureModel(script()) }) as any;
  assert.equal(resumed.status, 'WAITING_FOR_OWNER');
  const feedback = join(workspace, 'feedback.md'); writeFileSync(feedback, 'Please tighten the opening paragraph.');
  const revised = reviseAgentRun(workspace, first.run_id, feedback, { model: new FixtureModel(script()) }) as any;
  assert.equal(revised.status, 'WAITING_FOR_OWNER');
  rmSync(workspace, { recursive: true, force: true });
});

test('rendered role systems stay byte-identical to the pre-pack base plus the default writer style', () => {
  const expected: Record<string, Record<string, string>> = {
    newsletter: {
      director: '5505dcded93a182c027c6278f34c5f55278498454108e30a007b5354d7fb5ced',
      writer: '7e94236830c8b747b5f57a457956c69cc72c595ca592b0e6238b271de10926be',
      fact_reviewer: '147200ba7713d6b976cc0c96f4c2de62478cc0807561653898a7870b29072705',
      craft_reviewer: '34db4e2e2db0e8fd6b50718d1f487522d080c3435f426919daa922a06500c11f',
    },
    'conversion-copywriting': {
      director: '05da4abb859a17b532770fc2923da69f1c04b379d9590910d25fe32d87e599c4',
      writer: '3b44b799a41dde08038255f8dfca23f5878f84948601d9bfd7dcd2b5b2d369ef',
      fact_reviewer: '147200ba7713d6b976cc0c96f4c2de62478cc0807561653898a7870b29072705',
      craft_reviewer: '86ee7901f04dab15164abf84b71197789dd302e729ec8929127934244f27bb80',
    },
  };
  for (const [packId, hashes] of Object.entries(expected)) {
    const workspace = mkdtempSync(join(tmpdir(), `studio-pack-golden-${packId}-`));
    cpSync(join(REPO_ROOT, 'studio-runner/fixtures/agent-sample'), workspace, { recursive: true });
    const requestPath = join(workspace, 'request.json');
    const request = JSON.parse(readFileSync(requestPath, 'utf8')); request.provider = 'fixture'; request.pack_id = packId; delete request.specialist;
    writeFileSync(requestPath, JSON.stringify(request));
    const model = new FixtureModel(script());
    startAgentRun(workspace, requestPath, { model });
    for (const [role, expectedHash] of Object.entries(hashes)) assert.equal(hash(model.calls.find(c => c.role === role)!.system), expectedHash, `${packId}/${role}`);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a fixture pack runs end to end without a studio-runner/src change', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'studio-pack-e2e-'));
  const runSource = `
    import { startAgentRun } from ${JSON.stringify(join(REPO_ROOT, 'studio-runner/src/agent-run.ts'))};
    import { FixtureModel } from ${JSON.stringify(join(REPO_ROOT, 'studio-runner/src/model-port.ts'))};
    import { script } from ${JSON.stringify(join(REPO_ROOT, 'studio-runner/test/helpers/fixture-script.ts'))};
    const out = startAgentRun(process.argv[1], process.argv[2], { model: new FixtureModel(script()), allowDirtyPins: true });
    if (out.status !== 'WAITING_FOR_OWNER') throw new Error(JSON.stringify(out));
    console.log(JSON.stringify(out));
  `;
  const requestPath = join(workspace, 'request.json');
  const request = JSON.parse(readFileSync(join(REPO_ROOT, 'studio-runner/fixtures/agent-sample/request.json'), 'utf8'));
  request.provider = 'fixture'; request.pack_id = 'fixture-text'; delete request.specialist;
  cpSync(join(REPO_ROOT, 'studio-runner/fixtures/agent-sample'), workspace, { recursive: true });
  writeFileSync(requestPath, JSON.stringify(request));
  const p = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', runSource, workspace, requestPath], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, STUDIO_ALLOW_ENV_OVERRIDES: '1', STUDIO_PACKS_DIR: join(REPO_ROOT, 'studio-runner/test/fixtures/packs') },
  });
  try { assert.equal(p.status, 0, JSON.stringify({ status: p.status, stdout: p.stdout, stderr: p.stderr })); assert.equal(JSON.parse(p.stdout.trim()).status, 'WAITING_FOR_OWNER'); }
  finally { rmSync(workspace, { recursive: true, force: true }); }
});
