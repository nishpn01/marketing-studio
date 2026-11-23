import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/runner.ts';

const skillPath = join(REPO_ROOT, '.agents/skills/marketing-director/SKILL.md');
const installer = join(REPO_ROOT, 'hosts/codex/install.sh');
test('Codex host skill is discoverable and covers workflow boundaries', () => {
  const s = readFileSync(skillPath, 'utf8');
  assert.match(s, /^---\nname: marketing-director\ndescription:/);
  assert.ok(s.split('\n').length - 1 <= 30);
  for (const part of ['resume_session', 'discuss_brainstorm', 'propose_direction', 'produce', 'review', 'STUDIO_TOKEN', 'marketing-director-cli', 'Approvals happen in your Studio Inbox, never in chat.']) assert.ok(s.includes(part), part);
  assert.ok(!s.includes('session-status'));
});
test('Codex CLI Director skill keeps the CLI workflow boundaries', () => {
  const s = readFileSync(join(REPO_ROOT, '.agents/skills/marketing-director-cli/SKILL.md'), 'utf8');
  assert.match(s, /^---\nname: marketing-director-cli\ndescription:/);
  for (const part of ['session-status', 'improvement-list', 'context-search', 'direction-approve', 'session-run', 'improvement-handoff']) assert.ok(s.includes(part), part);
  assert.ok(s.includes('claude-code-cli'));
  assert.ok(s.includes('codex-cli'));
  assert.ok(!s.includes('NOT native Codex/OpenAI'));
  assert.ok(s.includes('restricted'));
});
test('Codex installer requires explicit workspace and safely writes local configuration', () => {
  const s = readFileSync(installer, 'utf8');
  assert.ok(s.includes('studio-business.json'));
  assert.ok(s.includes('python3 -'));
  assert.ok(s.includes('json.dumps'));
  assert.ok(s.includes('chmod 600'));
  assert.ok(s.includes('--bearer-token-env-var STUDIO_TOKEN'));
  assert.ok(existsSync(join(REPO_ROOT, 'hosts/codex/README.md')));
});
