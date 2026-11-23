import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentRun, skillPins } from '../src/agent-run.ts';
import { loadPack } from '../src/pack-loader.ts';
import { REPO_ROOT } from '../src/runner.ts';
import { FixtureModel } from '../src/model-port.ts';
import { script } from './helpers/fixture-script.ts';

const strategy = 'skills/copywriting/STRATEGY-CHECK.md';
const craft = 'skills/copywriting/MESSAGE-CRAFT.md';
const evalPath = 'skills/copywriting/READER-EVALUATION.md';

test('Copywriting methods are role-scoped and pinned as real skill files', () => {
  const pack = loadPack('newsletter');
  assert.ok(pack.roles.director.skills.includes(strategy));
  assert.ok(pack.roles.writer.skills.includes(craft));
  assert.ok(pack.roles.craft_reviewer.skills.includes(evalPath));
  assert.ok(pack.roles.fact_reviewer.skills.every((s: string) => !s.includes('copywriting')));
  for (const role of Object.keys(pack.roles)) {
    const paths: string[] = pack.roles[role as keyof typeof pack.roles].skills;
    assert.equal(new Set(paths).size, paths.length);
    for (const [i, p] of paths.entries()) assert.ok(existsSync(pack.role_files[role as keyof typeof pack.roles].skill_paths[i]), p);
  }
  const pins = skillPins().roles;
  for (const [role, p] of [['director', strategy], ['writer', craft], ['craft_reviewer', evalPath]] as const) {
    assert.match(pins[role].skills.find(x => x.path === p)?.sha256 ?? '', /^[a-f0-9]{64}$/);
  }
});

test('Fixture pipeline passes each copywriting method to the intended model only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copy-methods-ws-'));
  cpSync(join(REPO_ROOT, 'studio-runner/fixtures/agent-sample'), dir, { recursive: true });
  const requestPath = join(dir, 'request.json');
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  request.provider = 'fixture';
  writeFileSync(requestPath, JSON.stringify(request));
  const model = new FixtureModel(script());
  const out = startAgentRun(dir, requestPath, { model });
  assert.equal(out.status, 'WAITING_FOR_OWNER');
  const get = (role: string) => model.calls.find(c => c.role === role)!.system;
  assert.ok(get('director').includes('<skill path="skills/copywriting/STRATEGY-CHECK.md">'));
  assert.ok(get('writer').includes('<skill path="skills/copywriting/MESSAGE-CRAFT.md">'));
  assert.ok(get('craft_reviewer').includes('<skill path="skills/copywriting/READER-EVALUATION.md">'));
  assert.ok(!get('writer').includes('STRATEGY-CHECK.md'));
  assert.ok(!get('fact_reviewer').includes('skills/copywriting/'));
  assert.ok(!get('craft_reviewer').includes('MESSAGE-CRAFT.md'));
});
