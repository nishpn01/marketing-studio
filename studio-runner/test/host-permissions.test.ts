import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../src/runner.ts';

const cli = readFileSync(join(REPO_ROOT, 'studio-runner/src/cli.ts'), 'utf8');
const commands = [...cli.matchAll(/case '([a-z-]+)':/g)].map(m => m[1]);
const py = readFileSync(join(REPO_ROOT, 'hosts/claude-code/permissions.py'), 'utf8');
const rules = readFileSync(join(REPO_ROOT, 'hosts/codex/marketing-studio.rules'), 'utf8');
const list = (src: string, name: string) => [...src.match(new RegExp(name + ' = \\[([^\\]]*)\\]'))![1].matchAll(/"([a-z-]+)"/g)].map(m => m[1]);
const AUTH = ['source-disclosure-grant', 'source-disclosure-revoke', 'capture-disclosure-grant', 'capture-disclosure-revoke', 'direction-approve', 'approve', 'improvement-decide', 'session-run', 'session-rerun', 'run', 'revise', 'cancel'];

test('every CLI command is classified (ask or allow) in both host permission sets, so new commands cannot slip in unclassified', () => {
  assert.ok(commands.length > 30);
  for (const [src, a, b] of [[py, 'ASK', 'ALLOW'], [rules, 'AUTHORITY', 'READONLY']] as const) {
    const ask = list(src, a), allow = list(src, b);
    for (const c of commands) assert.ok(ask.includes(c) || allow.includes(c), `${c} unclassified`);
    for (const c of AUTH) assert.ok(ask.includes(c), `${c} must ask`);
    assert.deepEqual(ask.filter(c => allow.includes(c)), []);
  }
});

test('Claude Code installer merges ask/allow rules into the target settings only and preserves existing keys', () => {
  const d = join(mkdtempSync(join(tmpdir(), 'hp-')), '.claude'); mkdirSync(d);
  writeFileSync(join(d, 'settings.json'), JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls)'] } }));
  const run = () => spawnSync('python3', [join(REPO_ROOT, 'hosts/claude-code/permissions.py'), d, '/opt/s tudio/studio'], { encoding: 'utf8' });
  assert.equal(run().status, 0); assert.equal(run().status, 0); // idempotent
  const s = JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'));
  assert.equal(s.model, 'x'); assert.ok(s.permissions.allow.includes('Bash(ls)'));
  assert.equal(new Set(s.permissions.allow).size, s.permissions.allow.length);
  assert.ok(s.permissions.ask.includes('Bash(*studio* direction-approve*)'));
  for (const f of ['--allow-dirty-pins', '--owner-quote']) assert.ok(s.permissions.ask.includes(`Bash(*${f}*)`));
  assert.ok(s.permissions.allow.includes('Bash("/opt/s tudio/studio" session-status*)'));
  assert.ok(!s.permissions.allow.some((r: string) => /direction-approve|session-run|source-disclosure-grant/.test(r)));
});

test('checked-in host shims stay thin and route approvals to the inbox', () => {
  for (const p of ['hosts/claude-code/marketing-director/SKILL.md', '.agents/skills/marketing-director/SKILL.md']) {
    const s = readFileSync(join(REPO_ROOT, p), 'utf8');
    assert.ok(s.split('\n').length - 1 <= 30, p);
    assert.match(s, /Approvals happen in your Studio Inbox, never in chat\./, p);
    assert.match(s, /Never compose owner quotes or approvals/, p);
  }
});

test('CLI Director skill requires owner confirmation in the owner\'s own words and forbids agent-composed quotes', () => {
  const s = readFileSync(join(REPO_ROOT, 'hosts/claude-code/marketing-director-cli/SKILL.md'), 'utf8');
  assert.match(s, /^---\nname: marketing-director-cli\n/);
  assert.match(s, /## Owner authority: confirm first, never compose quotes/);
  assert.match(s, /in their own words in chat/);
  assert.match(s, /Never write, paraphrase, complete or infer a quote/);
});
