import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/runner.ts';

test('README mock quick-start command works without the test-only classification bypass', () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-readme-quickstart-'));
  try {
    const sample = join(root, 'sample');
    cpSync(join(REPO_ROOT, 'studio-runner/fixtures/sample'), sample, { recursive: true });
    const env = { ...process.env };
    delete env.STUDIO_ALLOW_UNCLASSIFIED_MOCK;
    const out = spawnSync(process.execPath, [
      '--experimental-strip-types',
      join(REPO_ROOT, 'studio-runner/src/cli.ts'),
      'run',
      '--workspace', sample,
      '--request', join(sample, 'request.json'),
    ], { cwd: REPO_ROOT, env, encoding: 'utf8' });

    assert.equal(out.status, 0, out.stderr);
    const result = JSON.parse(out.stdout);
    assert.equal(result.status, 'SIMULATION_COMPLETE');
    assert.equal(result.model_calls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
