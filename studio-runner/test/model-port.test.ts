import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelFor, ProviderError, ClaudeCodeCliModel, CodexCliModel } from '../src/model-port.ts';

test('provider selection is explicit and fails closed', () => {
  assert.ok(modelFor('claude-code-cli') instanceof ClaudeCodeCliModel);
  assert.ok(modelFor('codex-cli') instanceof CodexCliModel);
  for (const p of ['', 'fixture', 'openai', 'anthropic-api', 'Claude-Code-CLI', 'claude-code-cli ']) assert.throws(() => modelFor(p), (e: any) => e instanceof ProviderError && /Unknown provider/.test(e.message), p);
});

function codexStub() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-stub-')), bin = join(dir, 'codex'), record = join(dir, 'record.json');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }
const model = args[args.indexOf('--model') + 1];
const output = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args, input: fs.readFileSync(0, 'utf8'), openai: process.env.OPENAI_API_KEY, codex: process.env.CODEX_API_KEY}));
if (model === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
fs.writeFileSync(output, model === 'large' ? Buffer.alloc(20_000_001) : '{"ok":true}');
console.log(JSON.stringify({type:'thread.started',thread_id:'thread-1'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,cached_input_tokens:2,output_tokens:3}}));
`, { mode: 0o755 });
  return { dir, bin, record };
}
const request = { role: 'writer' as const, model: 'gpt-5.3-codex', system: 'SYSTEM-PRIVATE-8274', prompt: 'PROMPT-PRIVATE-8274' };

test('Codex CLI adapter uses the subscription-only read-only text path and records JSON usage', () => {
  const stub = codexStub();
  try {
    const result = new CodexCliModel(stub.bin).invoke(request);
    const seen = JSON.parse(readFileSync(stub.record, 'utf8'));
    assert.equal(result.text, '{"ok":true}');
    assert.equal(result.model_id, 'gpt-5.3-codex');
    assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3, notional_cost_usd: null, raw: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 3 }, billing: 'codex-cli reports a ChatGPT subscription login; external billing is not independently verified' });
    assert.equal(result.request_id, 'thread-1');
    assert.deepEqual(seen.args.slice(0, 7), ['exec', '--model', 'gpt-5.3-codex', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config']);
    for (const feature of ['shell_tool', 'unified_exec', 'unified_exec_tty', 'apps', 'browser_use', 'computer_use']) assert.ok(seen.args.includes(feature), feature);
    assert.ok(seen.args.includes('--json'));
    assert.equal(seen.args.includes('--approve-for-me'), false);
    assert.equal(seen.openai, undefined);
    assert.equal(seen.codex, undefined);
    assert.match(seen.input, /SYSTEM-PRIVATE-8274/);
    assert.ok(!seen.args.includes('SYSTEM-PRIVATE-8274'));
  } finally { rmSync(stub.dir, { recursive: true, force: true }); }
});

test('Codex CLI adapter refuses API-key environments before executing the binary', () => {
  const stub = codexStub(), previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-secret-never-forward';
  try {
    assert.throws(() => new CodexCliModel(stub.bin).invoke(request), /OPENAI_API_KEY is set; refusing/);
    assert.equal(existsSync(stub.record), false);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test('Codex CLI adapter maps timeout and oversized output to provider failures', () => {
  const stub = codexStub();
  try {
    assert.throws(() => new CodexCliModel(stub.bin, 100).invoke({ ...request, model: 'slow' }), /timed out/);
    assert.throws(() => new CodexCliModel(stub.bin).invoke({ ...request, model: 'large' }), /output exceeds/);
  } finally { rmSync(stub.dir, { recursive: true, force: true }); }
});
