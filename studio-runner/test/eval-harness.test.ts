import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runEval } from '../src/eval.ts';
import { copyPacks, packManifest, savePackManifest } from './helpers/pack-test.ts';

function fixtureFile(packs: string, id: string) { return join(packs, 'newsletter', 'evals', `${id}.json`); }
function editFixture(packs: string, id: string, edit: (fixture: any) => void) {
  const file = fixtureFile(packs, id);
  const fixture = JSON.parse(readFileSync(file, 'utf8'));
  edit(fixture);
  writeFileSync(file, JSON.stringify(fixture));
}

test('eval replay executes all regression cases deterministically', () => {
  const resultsDir = mkdtempSync(join(tmpdir(), 'studio-eval-results-'));
  try {
    const first = runEval('newsletter', { resultsDir });
    const second = runEval('newsletter', { resultsDir });
    assert.deepEqual(second, first);
    assert.deepEqual(first.totals, { cases: 11, replayed: 9, passed: 9, failed: 0, live_only: 2 });
    assert.equal(first.cases.filter(c => c.pass === false).length, 0);
    assert.match(readFileSync(first.summary_path, 'utf8'), /Deterministic replay passed/);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
  }
});

test('eval baseline diff reports a regression from a broken pack gate', () => {
  const packs = copyPacks('studio-eval-packs-');
  const resultsDir = mkdtempSync(join(tmpdir(), 'studio-eval-baseline-'));
  const previousPacks = process.env.STUDIO_PACKS_DIR;
  const previousOverrides = process.env.STUDIO_ALLOW_ENV_OVERRIDES;
  process.env.STUDIO_ALLOW_ENV_OVERRIDES = '1';
  process.env.STUDIO_PACKS_DIR = packs;
  try {
    const baselineDir = join(resultsDir, 'baseline');
    const baseline = runEval('newsletter', { resultsDir: baselineDir });
    const { file, value } = packManifest(packs, 'newsletter');
    value.gates.min_draft_words = 10000;
    savePackManifest(file, value);
    const current = runEval('newsletter', { resultsDir: join(resultsDir, 'broken'), baseline: baseline.result_path });
    assert.ok(current.baseline_diff?.regressions.length);
    assert.match(readFileSync(current.summary_path, 'utf8'), /## Regressions/);
    assert.ok(current.baseline_diff!.regressions.some(x => x.id === 'STORY-01'));
  } finally {
    rmSync(packs, { recursive: true, force: true });
    rmSync(resultsDir, { recursive: true, force: true });
    if (previousPacks === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previousPacks;
    if (previousOverrides === undefined) delete process.env.STUDIO_ALLOW_ENV_OVERRIDES; else process.env.STUDIO_ALLOW_ENV_OVERRIDES = previousOverrides;
  }
});

test('eval baseline git refs run in a temporary worktree and report pack regressions', () => {
  const packs = copyPacks('studio-eval-git-baseline-');
  const resultsDir = mkdtempSync(join(tmpdir(), 'studio-eval-git-results-'));
  const previousPacks = process.env.STUDIO_PACKS_DIR;
  const previousOverrides = process.env.STUDIO_ALLOW_ENV_OVERRIDES;
  process.env.STUDIO_ALLOW_ENV_OVERRIDES = '1';
  process.env.STUDIO_PACKS_DIR = packs;
  try {
    const baselineRef = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const { file, value } = packManifest(packs, 'newsletter');
    value.gates.min_draft_words = 10000;
    savePackManifest(file, value);
    const current = runEval('newsletter', { baseline: baselineRef, resultsDir: join(resultsDir, 'broken') });
    assert.ok(current.baseline_diff?.regressions.length);
    assert.equal(current.pass, false);
    assert.equal(current.baseline_diff?.fixture_expectations_changed, false);
    assert.match(readFileSync(current.summary_path, 'utf8'), /temporary git worktree/);
    editFixture(packs, 'COUNT-01', fixture => { fixture.expected.current_version = 'v003'; });
    const rekeyed = runEval('newsletter', { baseline: baselineRef, resultsDir: join(resultsDir, 'rekeyed') });
    assert.equal(rekeyed.baseline_diff?.fixture_expectations_changed, true);
  } finally {
    rmSync(packs, { recursive: true, force: true });
    rmSync(resultsDir, { recursive: true, force: true });
    if (previousPacks === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previousPacks;
    if (previousOverrides === undefined) delete process.env.STUDIO_ALLOW_ENV_OVERRIDES; else process.env.STUDIO_ALLOW_ENV_OVERRIDES = previousOverrides;
  }
});

test('adversarial fixture mutations flip the eval result', () => {
  const packs = copyPacks('studio-eval-adversarial-');
  const resultsDir = mkdtempSync(join(tmpdir(), 'studio-eval-adversarial-results-'));
  const previousPacks = process.env.STUDIO_PACKS_DIR;
  const previousOverrides = process.env.STUDIO_ALLOW_ENV_OVERRIDES;
  process.env.STUDIO_ALLOW_ENV_OVERRIDES = '1';
  process.env.STUDIO_PACKS_DIR = packs;
  try {
    const baseline = runEval('newsletter', { resultsDir: join(resultsDir, 'baseline') });
    assert.equal(baseline.pass, true);
    const mutations: [string, (fixture: any) => void][] = [
      ['STORY-01', fixture => { fixture.responses.fact_reviewer.claims[0].source_excerpt = 'The project journal lists three revisions and their dates.'; }],
      ['NEGATIVE-01', fixture => { fixture.responses.fact_reviewer.unlisted_claims = []; }],
      ['PRIVACY-01', fixture => { delete fixture.source_disclosure_grants; }],
      ['COUNT-01', fixture => { fixture.responses.fact_reviewer.claims[0].verdict = 'supported'; }],
      ['GATE-01', fixture => { fixture.responses.writer.draft_markdown = '# ' + fixture.responses.writer.draft_markdown; }],
    ];
    for (const [id, mutate] of mutations) {
      const original = JSON.parse(readFileSync(fixtureFile(packs, id), 'utf8'));
      editFixture(packs, id, mutate);
      const mutated = runEval('newsletter', { resultsDir: join(resultsDir, id) });
      assert.equal(mutated.cases.find(c => c.id === id)?.pass, false, `${id} mutation should fail its expected disposition`);
      writeFileSync(fixtureFile(packs, id), JSON.stringify(original));
    }
  } finally {
    rmSync(packs, { recursive: true, force: true });
    rmSync(resultsDir, { recursive: true, force: true });
    if (previousPacks === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previousPacks;
    if (previousOverrides === undefined) delete process.env.STUDIO_ALLOW_ENV_OVERRIDES; else process.env.STUDIO_ALLOW_ENV_OVERRIDES = previousOverrides;
  }
});

test('prompt changes produce stale recordings before ordinary regressions', () => {
  const packs = copyPacks('studio-eval-stale-');
  const resultsDir = mkdtempSync(join(tmpdir(), 'studio-eval-stale-results-'));
  const previousPacks = process.env.STUDIO_PACKS_DIR;
  const previousOverrides = process.env.STUDIO_ALLOW_ENV_OVERRIDES;
  process.env.STUDIO_ALLOW_ENV_OVERRIDES = '1';
  process.env.STUDIO_PACKS_DIR = packs;
  try {
    const baseline = runEval('newsletter', { resultsDir: join(resultsDir, 'baseline') });
    const prompt = join(packs, 'newsletter', 'prompts', 'writer.md');
    writeFileSync(prompt, readFileSync(prompt, 'utf8') + '\nPrompt mutation for stale-recording coverage.\n');
    const current = runEval('newsletter', { baseline: baseline.result_path, resultsDir: join(resultsDir, 'current') });
    assert.equal(current.cases.find(c => c.id === 'STORY-01')?.status, 'STALE_RECORDING');
    assert.ok(current.baseline_diff?.stale_recordings.length);
    const staleIds = new Set(current.baseline_diff!.stale_recordings.map(x => x.id));
    assert.ok(current.baseline_diff!.regressions.every(x => !staleIds.has(x.id)));
    assert.equal(current.pass, false);
    const summary = readFileSync(current.summary_path, 'utf8');
    assert.ok(summary.indexOf('## Stale recordings') < summary.indexOf('## Regressions'));
  } finally {
    rmSync(packs, { recursive: true, force: true });
    rmSync(resultsDir, { recursive: true, force: true });
    if (previousPacks === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previousPacks;
    if (previousOverrides === undefined) delete process.env.STUDIO_ALLOW_ENV_OVERRIDES; else process.env.STUDIO_ALLOW_ENV_OVERRIDES = previousOverrides;
  }
});

test('live eval refuses without a configured provider and remains a stub when configured', () => {
  const previous = process.env.STUDIO_EVAL_PROVIDER;
  delete process.env.STUDIO_EVAL_PROVIDER;
  try {
    assert.throws(() => runEval('newsletter', { live: true }), /STUDIO_EVAL_PROVIDER/);
    process.env.STUDIO_EVAL_PROVIDER = 'fixture';
    assert.throws(() => runEval('newsletter', { live: true }), /not implemented in v0/);
  } finally {
    if (previous === undefined) delete process.env.STUDIO_EVAL_PROVIDER; else process.env.STUDIO_EVAL_PROVIDER = previous;
  }
});
