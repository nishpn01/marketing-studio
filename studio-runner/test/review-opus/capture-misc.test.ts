/** Opus final review: capture import cost and capture-record redaction gaps. Synthetic sentinels only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureImport, captureAnnotate } from '../../src/conversation-capture.ts';
import { contextSearch } from '../../src/director-session.ts';
import { bizWs } from '../adversarial/harness.ts';

const biz = (redact: string[] = []) => bizWs([], {}, { capture: { enabled: true, allowed_hosts: ['codex'], redact } });

test('OPUS-C1 (fixed): claude-code-jsonl import is linear in unclosed <command-x> / <system-reminder> openers', () => {
  const b = biz();
  const time = (n: number) => {
    const f = join(b.top, `t${n}.jsonl`);
    writeFileSync(f, JSON.stringify({ type: 'user', message: { content: 'Owner text ' + '<command-x>'.repeat(n) } }) + '\n');
    const t = process.hrtime.bigint();
    captureImport(b.ws, { file: f, host: 'codex', format: 'claude-code-jsonl', authorization: 'Owner authorised this import', title: `t${n}` });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  time(500); const small = time(4000), big = time(16000), ratio = big / Math.max(small, 1);
  // Wall-clock ratios are scheduler-sensitive under the required concurrent suite; the absolute bound still catches quadratic growth.
  assert.ok(big < 1500 && (small < 10 || ratio < 8), `4x input took ${ratio.toFixed(1)}x longer (${small.toFixed(0)} ms -> ${big.toFixed(0)} ms)`);
});

test('OPUS-C2 (fixed): capture titles and annotate paraphrases get profile redaction', () => {
  const LANDLORD = 'Landlordname Zyxwv';
  const b = biz([LANDLORD]);
  const f = join(b.top, 'a.txt'); writeFileSync(f, `Owner: We decided to use stickers; ${LANDLORD} owns the shed.\nAssistant: Noted.\n`);
  const c: any = captureImport(b.ws, { file: f, host: 'codex', format: 'text', authorization: 'Owner authorised this import', title: `Chat about ${LANDLORD}`, visibility: 'approved' });
  const rec = join(b.top, 'rec.json');
  writeFileSync(rec, JSON.stringify({ items: [{ type: 'decision', message: 1, quote: 'We decided to use stickers', text: `Use stickers in ${LANDLORD}'s shed` }] }));
  captureAnnotate(b.ws, c.capture_id, rec, 'codex:director');
  const out = JSON.stringify(contextSearch(b.ws, 'stickers shed', 20));
  assert.ok(!out.includes(LANDLORD), 'profile-redacted name must not be served from record item text or title');
  assert.ok(out.includes('[omitted for privacy]'), 'CONTROL: the message text itself was redacted');
});

test('strip(): closed command and system-reminder blocks are still removed', () => {
  const b = biz(); const f = join(b.top, 's.jsonl');
  writeFileSync(f, JSON.stringify({ type: 'user', message: { content: 'Owner text one.<system-reminder>HIDDEN-REMINDER</system-reminder> and <command-name>HIDDEN-CMD</command-name>done' } }) + '\n');
  const c: any = captureImport(b.ws, { file: f, host: 'codex', format: 'claude-code-jsonl', authorization: 'Owner authorised this import', title: 'strip', visibility: 'approved' });
  const t = JSON.stringify(contextSearch(b.ws, 'owner text one done', 20));
  assert.ok(c.messages >= 1 && !t.includes('HIDDEN-'));
});
