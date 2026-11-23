/** Independent review: recovery, idempotency, budgets, read-only status/inspect and lock handling. Synthetic data only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync, mkdirSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sessionStart, evidenceAddHost, directionApprove, sessionRun, sessionRerun, sessionStatus, loadSession, saveSession } from '../../src/director-session.ts';
import { reviseAgentRun, approveAgentRun, resumeAgentRun } from '../../src/agent-run.ts';
import { listRuns, inspectRun, withWorkspaceLock, REPO_ROOT } from '../../src/runner.ts';
import { FixtureModel } from '../../src/model-port.ts';
import { script } from '../helpers/fixture-script.ts';
import { bizWs, editBiz, direction, jread, FIX } from '../adversarial/harness.ts';

function session(slug: string, budget?: Partial<{ max_model_calls: number; max_revision_rounds: number }>) {
  const b = bizWs(); if (budget) editBiz(b.ws, x => Object.assign(x.defaults.budget, budget));
  sessionStart(b.ws, 'A synthetic newsletter about hand tracking first', slug);
  ['volunteer-log.md', 'member-comments.md', 'committee-decision.md'].forEach((n, i) => evidenceAddHost(b.ws, slug, { kind: 'web', uri: `https://example.org/${i}`, file: join(FIX, 'sources', n), retrieved_by: 'claude-code:WebFetch' }));
  directionApprove(b.ws, slug, direction(b.ws));
  return { ...b, slug };
}
const snapshot = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = join(dir, e.name);
  if (e.isDirectory()) return [`D ${p}`, ...snapshot(p)];
  const st = lstatSync(p); return [`F ${p} ${st.size} ${st.mtimeMs} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`];
}).sort();

test('CONTROL: status, inspect and session-status write nothing and create no .studio', () => {
  const t = session('ro-sess');
  const out = sessionRun(t.ws, 'ro-sess', { model: new FixtureModel(script()) }) as any;
  const before = snapshot(t.ws);
  listRuns(t.ws); inspectRun(t.ws, out.run_id); sessionStatus(t.ws, 'ro-sess'); sessionStatus(t.ws);
  assert.deepEqual(snapshot(t.ws), before, 'workspace changed after read-only commands');
  // virgin workspace: nothing is created
  const v = bizWs(); writeFileSync(join(v.ws, 'studio-workspace.json'), JSON.stringify({ schema_version: 'studio.workspace/0.1', workspace_id: 'adv-biz' }));
  assert.deepEqual(listRuns(v.ws), []);
  assert.throws(() => inspectRun(v.ws, 'nope'), /does not exist/);
  assert.ok(!existsSync(join(v.ws, '.studio')), '.studio created by a read-only command');
  // also via the real CLI
  const r = spawnSync(join(REPO_ROOT, 'studio-runner/bin/studio'), ['status', '--workspace', v.ws], { encoding: 'utf8' });
  assert.equal(r.status, 0); assert.ok(!existsSync(join(v.ws, '.studio')));
});

test('CONTROL: an interrupted run (exit after model intent) resumes exactly once per step and counts the unknown usage', () => {
  const t = session('crash-ok');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, 'crash-child.ts'), t.ws, 'crash-ok'], { env: { ...process.env, STUDIO_FAULT_BEFORE_RECEIPT: 'fact_v001' }, encoding: 'utf8' });
  assert.equal(r.status, 75);
  const [run] = listRuns(t.ws); assert.ok(run);
  const m = new FixtureModel(script());
  const out: any = resumeAgentRun(t.ws, run.run_id, { model: m });
  assert.equal(out.status, 'WAITING_FOR_OWNER');
  assert.deepEqual(m.calls.map(c => c.role), ['fact_reviewer', 'craft_reviewer'], 'earlier receipts reused, no duplicate director/writer call');
  assert.ok(inspectRun(t.ws, run.run_id).events.some(e => e.event_type === 'usage_unknown'));
});

test('F-REL-1 (fixed): a crash leaves the session linked to its run and recoverable; session-rerun works, session-run explains', () => {
  const t = session('crash-wedge');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, 'crash-child.ts'), t.ws, 'crash-wedge'], { env: { ...process.env, STUDIO_FAULT_BEFORE_RECEIPT: 'fact_v001' }, encoding: 'utf8' });
  assert.equal(r.status, 75);
  const [run] = listRuns(t.ws);
  const s = loadSession(t.ws, 'crash-wedge'); assert.equal(s.state, 'running'); assert.equal(s.run_id, run.run_id, 'run linked as soon as it exists');
  assert.equal(sessionStatus(t.ws, 'crash-wedge')[0].run?.run_id, run.run_id);
  assert.throws(() => sessionRun(t.ws, 'crash-wedge', { model: new FixtureModel(script()) }), /session is run_failed/);
  assert.equal(loadSession(t.ws, 'crash-wedge').state, 'run_failed');
  const out: any = sessionRerun(t.ws, 'crash-wedge', 'retry after crash please', { model: new FixtureModel(script()) });
  assert.equal(out.status, 'WAITING_FOR_OWNER');
  const after = loadSession(t.ws, 'crash-wedge'); assert.equal(after.state, 'in_review'); assert.deepEqual(after.previous_runs, [run.run_id]);
});

test('F-REL-1b (fixed): a crash before any run row exists returns the session to direction_approved', () => {
  const t = session('crash-early'); const s = loadSession(t.ws, 'crash-early'); s.state = 'running'; s.run_id = null; saveSession(realpathSync(t.ws), s, 'simulated_crash');
  assert.equal((sessionRun(t.ws, 'crash-early', { model: new FixtureModel(script()) }) as any).status, 'WAITING_FOR_OWNER');
});

test('F-REL-2 (fixed): an owner revision gets its own allowance, so the reviewed run stays approvable', () => {
  const t = session('budget-sess', { max_model_calls: 4, max_revision_rounds: 0 });
  const out: any = sessionRun(t.ws, 'budget-sess', { model: new FixtureModel(script()) });
  assert.equal(out.status, 'WAITING_FOR_OWNER'); assert.equal(out.model_calls, 4);
  const fb = join(t.top, 'fb.md'); writeFileSync(fb, 'Please tighten the opening paragraph.');
  const rev: any = reviseAgentRun(t.ws, out.run_id, fb, { model: new FixtureModel(script()) });
  assert.equal(rev.status, 'WAITING_FOR_OWNER'); assert.equal(rev.version, 'v002');
  assert.equal(inspectRun(t.ws, out.run_id).status, 'WAITING_FOR_OWNER');
  const digest = jread(join(out.artifact_dir, 'run-snapshot.json')).current_digest;
  assert.equal((approveAgentRun(t.ws, out.run_id, digest) as any).status, 'ASSET_APPROVED');
});

test('CONTROL: lock handling - live holder refuses, dead holder is recovered, garbage lock needs manual action', () => {
  const t = session('lock-sess'); const lock = join(t.ws, '.studio', 'runner.lock'); mkdirSync(join(t.ws, '.studio'), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'x', started: new Date().toISOString() }));
  assert.throws(() => withWorkspaceLock(t.ws, () => 1), /already executing/);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); // exited => ESRCH
  writeFileSync(lock, JSON.stringify({ pid: Number(dead.stdout), nonce: 'x', started: new Date().toISOString() }));
  assert.equal(withWorkspaceLock(t.ws, () => 'ok'), 'ok'); assert.ok(!existsSync(lock));
  writeFileSync(lock, '{not json');
  assert.throws(() => withWorkspaceLock(t.ws, () => 1), /Unreadable lock/);
  writeFileSync(lock, JSON.stringify({ pid: -1, nonce: 1 }));
  assert.throws(() => withWorkspaceLock(t.ws, () => 1), /Untrusted lock/);
});

test('F-REL-3 (fixed): a concurrent session-run loser leaves the session untouched', () => {
  const t = session('race-sess'); const lock = join(t.ws, '.studio', 'runner.lock'); mkdirSync(join(t.ws, '.studio'), { recursive: true });
  const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},4000)']); // a live pid standing in for the winning runner
  try {
    writeFileSync(lock, JSON.stringify({ pid: holder.pid, nonce: 'w', started: new Date().toISOString() }));
    assert.throws(() => sessionRun(t.ws, 'race-sess', { model: new FixtureModel(script()) }), /already executing/);
    const s = loadSession(t.ws, 'race-sess');
    assert.equal(s.state, 'direction_approved'); assert.ok(!s.history.some(h => h.event === 'run_failed'));
  } finally { holder.kill(); }
});
void tmpdir; void mkdtempSync; void cpSync;
