/** Final-diff review: the linear-time strip() rewrite in conversation-capture.ts vs the former lazy regexes. Synthetic sentinels only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureImport } from '../../src/conversation-capture.ts';
import { bizWs } from '../adversarial/harness.ts';

const SENT = 'FINALREV-REMINDER-SENTINEL';
function imported(content: string) {
  const b = bizWs([], {}, { capture: { enabled: true, allowed_hosts: ['codex'], redact: [] } });
  const f = join(b.top, 'c.jsonl'); writeFileSync(f, JSON.stringify({ type: 'user', message: { content } }) + '\n');
  const c: any = captureImport(b.ws, { file: f, host: 'codex', format: 'claude-code-jsonl', authorization: 'Owner authorised this import', title: 'probe' });
  return readFileSync(join(b.ws, 'captures', c.capture_id, 'transcript.json'), 'utf8');
}
test('CONTROL: well-formed and nested reminder/command blocks are removed', () => {
  assert.ok(!imported(`Owner text <system-reminder>${SENT}</system-reminder> end`).includes(SENT));
  assert.ok(!imported(`Owner text <command-message>x <system-reminder>${SENT}</system-reminder></command-message> end`).includes(SENT));
});
test('FINAL-C1 (regression, low): a reminder whose body contains the closer of an enclosing command tag now leaks its tail', () => {
  assert.ok(!imported(`Owner text <command-message>run <system-reminder>ctx </command-message> ${SENT}</system-reminder> after`).includes(SENT));
});
