/**
 * Final-diff review (3d3b75b..e9228dd): supersede/rerun ordering, revision cap, dirty-pin detection limits.
 * Synthetic fixtures only. { todo } tests assert the SAFE behaviour and reproduce open findings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { sessionStart, evidenceAddCatalog, directionApprove, sessionRun, sessionRerun, loadSession } from '../../src/director-session.ts';
import { skillPins, assertPinsClean } from '../../src/agent-run.ts';
import { REPO_ROOT, inspectRun } from '../../src/runner.ts';
import { FixtureModel } from '../../src/model-port.ts';
import { script, brief, draft, facts, DRAFT } from '../helpers/fixture-script.ts';
import { copyPacks, packManifest, savePackManifest } from '../helpers/pack-test.ts';

function model() {
  const two = (ids: string[]) => ids.map(s => (s === 'src_3' ? 'src_2' : s));
  return new FixtureModel(script({
    director: () => JSON.stringify(brief({ evidence_plan: [{ point: 'p', source_ids: ['src_1'] }, { point: 'q', source_ids: ['src_2'] }] })),
    writer: () => JSON.stringify(draft({ claims: draft().claims.map(c => ({ ...c, source_ids: two(c.source_ids) })) }, DRAFT)),
    fact_reviewer: () => JSON.stringify(facts(facts().claims.map(c => ({ ...c, verdict: 'not_checked' })))),
  }));
}
function inReview() {
  const top = mkdtempSync(join(tmpdir(), 'final-')); const ws = join(top, 'ws'), docs = join(top, 'docs');
  mkdirSync(ws); mkdirSync(docs); mkdirSync(join(ws, 'context'));
  writeFileSync(join(docs, 'notes.md'), '# Notes\n\n## Status\nThe status column mixed stage and outcome in one cell.\n');
  writeFileSync(join(docs, 'more.md'), '# More\n\nWe walked the process and corrected the map.\n');
  writeFileSync(join(ws, 'studio-business.json'), JSON.stringify({ schema_version: 'studio.business/0.1', workspace_id: 'final-test', vars: { D: docs }, allowed_roots: ['${D}'],
    defaults: { audience: 'teams', provider: 'claude-code-cli', models: { director: 's', writer: 's', fact_reviewer: 's', craft_reviewer: 's' }, budget: { max_model_calls: 12, max_steps: 40, max_revision_rounds: 0 } },
    catalog: [{ id: 'notes', path: '${D}/notes.md', visibility: 'approved', description: 'n' }, { id: 'more', path: '${D}/more.md', visibility: 'approved', description: 'm' }] }));
  sessionStart(ws, 'newsletter about status fields', 'final-issue');
  evidenceAddCatalog(ws, 'final-issue', 'notes'); evidenceAddCatalog(ws, 'final-issue', 'more');
  const d = join(top, 'd.json'); writeFileSync(d, JSON.stringify({ reader_question: 'Why does a status field matter?', angle: 'Walk the work first', reader_promise: 'Check one field', audience: 'teams', exclusions: [], approval: { type: 'owner', quote: 'Go with that angle.' } }));
  directionApprove(ws, 'final-issue', d);
  return { ws, top, run: sessionRun(ws, 'final-issue', { model: model() }) as any };
}
/** Point the pack loader at an ignored temporary skill so parallel git-status tests never observe it. */
function withDirtyPin<T>(f: () => T): T {
  const privateRoot = join(REPO_ROOT, 'workspace-private'); mkdirSync(privateRoot, { recursive: true });
  const tempRoot = mkdtempSync(join(privateRoot, 'final-dirty-')), abs = join(tempRoot, 'dirty-skill.md'), rel = relative(REPO_ROOT, abs);
  const packs = copyPacks('final-packs-');
  const { file, value: pack } = packManifest(packs, 'newsletter');
  pack.roles.writer.skills = [...pack.roles.writer.skills, rel]; savePackManifest(file, pack);
  writeFileSync(abs, 'Write plainly.\n');
  const previous = process.env.STUDIO_PACKS_DIR;
  process.env.STUDIO_ALLOW_ENV_OVERRIDES = '1'; process.env.STUDIO_PACKS_DIR = packs;
  try { return f(); } finally {
    rmSync(tempRoot, { recursive: true, force: true }); rmSync(packs, { recursive: true, force: true });
    if (previous === undefined) delete process.env.STUDIO_PACKS_DIR; else process.env.STUDIO_PACKS_DIR = previous;
    delete process.env.STUDIO_ALLOW_ENV_OVERRIDES;
  }
}
const superseded = (ws: string, id: string) => inspectRun(ws, id).events.some((e: any) => e.event_type === 'superseded');

test('CONTROL: dirty pins refuse session-run before any model call; untracked pinned file is listed', () => {
  withDirtyPin(() => {
    assert.ok(skillPins().dirty.some(path => path.startsWith('workspace-private/final-dirty-') && path.endsWith('/dirty-skill.md')));
    assert.throws(() => assertPinsClean(undefined, false), /uncommitted changes/);
    assert.doesNotThrow(() => assertPinsClean(undefined, true));
  });
});

test('FINAL-S1: a session-rerun that is refused (dirty pins) must not supersede the earlier, still-approvable run', () => {
  const { ws, run } = inReview();
  assert.equal(run.status, 'WAITING_FOR_OWNER');
  withDirtyPin(() => assert.throws(() => sessionRerun(ws, 'final-issue', 'rerun after a skill change', { model: model() }), /uncommitted changes/));
  const s = loadSession(ws, 'final-issue');
  assert.equal(superseded(ws, run.run_id), false, 'old run was superseded although no replacement run was created');
  assert.equal(s.run_id, run.run_id, 'session lost its link to the reviewable run');
});

test('CONTROL: a session-rerun refused for changed evidence leaves the earlier run untouched', () => {
  const { ws, run } = inReview(); const s = loadSession(ws, 'final-issue');
  writeFileSync(join(ws, s.evidence[0].path), 'changed');
  assert.throws(() => sessionRerun(ws, 'final-issue', 'rerun after an edit', { model: model() }), /Evidence changed/);
  assert.equal(superseded(ws, run.run_id), false);
});

test('FINAL-G2: with git unavailable, dirty detection silently reports clean (git_commit null)', () => {
  withDirtyPin(() => {
    const path = process.env.PATH; process.env.PATH = '/nonexistent';
    try { assert.throws(() => assertPinsClean(undefined, false)); } finally { process.env.PATH = path; }
  });
});
