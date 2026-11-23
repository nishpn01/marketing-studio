import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/runner.ts';

// Rules that must live in one owner file but that a prompt needs inline are copied; these tests keep every copy identical to its owner.
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readJson = (p: string) => JSON.parse(read(p));
const packs = ['newsletter', 'conversion-copywriting'];

function pinnedFiles(): string[] {
  const out = new Set<string>(['packs/shared/fact-reviewer.md']);
  for (const id of packs) {
    const pack = readJson(`packs/${id}/pack.json`);
    for (const role of Object.values<any>(pack.roles)) {
      out.add(join('packs', id, role.prompt));
      for (const skill of role.skills) out.add(skill);
    }
  }
  return [...out];
}

const backticked = (line: string) => [...line.matchAll(/`([a-z][a-z-]+)`/g)].map(m => m[1]).filter(c => !c.startsWith('--'));
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const pyList = (src: string, name: string) => [...src.match(new RegExp(name + ' = \\[([^\\]]*)\\]'))![1].matchAll(/"([a-z-]+)"/g)].map(m => m[1]);

test('the owner-authority command list in both CLI skills, HOST-PERMISSIONS and the Codex rules matches permissions.py', () => {
  const ask = sorted(pyList(read('hosts/claude-code/permissions.py'), 'ASK'));
  for (const p of ['hosts/claude-code/marketing-director-cli/SKILL.md']) {
    const line = read(p).split('\n').find(l => l.startsWith('These commands carry the owner\'s authority'))!;
    assert.deepEqual(sorted(backticked(line)), ask, p);
  }
  const hp = read('docs/hosts/HOST-PERMISSIONS.md').split('\n').find(l => l.startsWith('- `permissions.ask`'))!;
  const inner = hp.slice(hp.indexOf('subcommand (') + 1, hp.indexOf('), plus'));
  const expanded = backticked(inner.replace(/`([a-z-]+-)([a-z]+)((?:\/[a-z]+)+)`/g, (_m, stem, a, rest) => [a, ...rest.slice(1).split('/')].map(x => `\`${stem}${x}\``).join(', ')));
  assert.deepEqual(sorted(expanded), ask, 'HOST-PERMISSIONS');
  // Codex execpolicy cannot match flags, so evidence-add (which can carry --owner-quote) always prompts there.
  assert.deepEqual(sorted(pyList(read('hosts/codex/marketing-studio.rules'), 'AUTHORITY')), sorted([...ask, 'evidence-add']));
});

test('the clarifying-question cap is 1-2 everywhere core/DIRECTOR.md is restated', () => {
  assert.match(read('core/DIRECTOR.md'), /Ask no more than 1–2 genuinely consequential clarifying questions/);
  assert.match(read('core/IDEA-TO-CAMPAIGN.md'), /Ask at most 1–2 decisive questions/);
  assert.match(read('hosts/claude-code/marketing-director-cli/SKILL.md'), /Ask at most 1–2 sharp questions/);
  assert.match(read('studio-runner/src/service/mcp-prompts.ts'), /ask at most one or two questions/);
  for (const p of ['hosts/claude-code/marketing-director-cli/SKILL.md', 'studio-runner/src/service/mcp-prompts.ts', 'studio-runner/test/fixtures/director-prompts.golden.json']) {
    assert.doesNotMatch(read(p), /2–3 sharp questions|two or three questions/, p);
  }
});

test('the revision cap lives in one place: pack budget_defaults under the contract ceiling, with no number in pinned prompts', () => {
  const ceiling = Number(read('core/SPECIALIST-CONTRACT.md').match(/^retry_limit: (\d+)/m)![1]);
  const defaults = packs.map(id => readJson(`packs/${id}/pack.json`).budget_defaults);
  for (const d of defaults) assert.ok(d.max_revision_rounds >= 0 && d.max_revision_rounds <= ceiling);
  for (const p of pinnedFiles()) assert.doesNotMatch(read(p), /revise at most|at most twice/i, p);
  // Both templates restate the budget for the legacy CLI session path; they must equal the pack defaults.
  for (const p of ['templates/workspace/studio-business.example.json', 'templates/workspace/studio-self/studio-business.json']) {
    for (const d of defaults) assert.deepEqual(readJson(p).defaults.budget, d, p);
  }
});

test('gate verdict names have one owner, the quality gate contract, and the metadata gate output is mapped there', () => {
  const contract = read('core/QUALITY-GATE-CONTRACT.md');
  for (const v of ['BLOCK', 'REVISE', 'READY_FOR_OWNER_REVIEW']) assert.match(contract, new RegExp(`\\*\\*${v}:\\*\\*`));
  assert.match(contract, /\| Craft reviewer JSON `verdict` \| `ready` \/ `revise` \|/);
  assert.match(contract, /\| Metadata gate output \| `READY_FOR_EDITOR_REVIEW` \|/);
  assert.match(read('tools/newsletter_gate.py'), /"READY_FOR_EDITOR_REVIEW"/);
  assert.match(read('packs/newsletter/prompts/craft-reviewer.md'), /"verdict":"ready"\|"revise"/);
  for (const p of pinnedFiles()) assert.doesNotMatch(read(p), /PASS FOR OWNER REVIEW|PASS \/ REVISE \/ BLOCK/, p);
});

test('pinned prompt inputs carry behavior rules only: no release status prose and no global tenant style ban', () => {
  for (const p of pinnedFiles()) {
    assert.doesNotMatch(read(p), /proposed v0\.1|v0\.7 draft release|planned, not running|implemented on this branch|Not implemented in this pilot/i, p);
  }
  assert.doesNotMatch(read('packs/newsletter/prompts/writer.md'), /em dash|Sentence-case headings|motivational close/i);
});

test('reusable files name no private business or tenant', () => {
  const roots = ['AGENTS.md', 'README.md', 'core', 'skills', 'specialists', 'hosts', '.agents', 'packs', 'templates', 'tools', 'evaluations'];
  const banned = /\bScribe\b|source-private-tenant|source-private-tenant|Builder's Quest|Building with AI|rejected-isnt/;
  const walk = (p: string): string[] => {
    const abs = join(REPO_ROOT, p);
    return statSync(abs).isDirectory() ? readdirSync(abs).flatMap(n => (n === 'node_modules' || n === '__pycache__' ? [] : walk(join(p, n)))) : [p];
  };
  for (const file of roots.flatMap(walk).filter(file => file !== 'tools/export-public-edition/export_public_edition.py')) assert.doesNotMatch(read(file), banned, file);
});
