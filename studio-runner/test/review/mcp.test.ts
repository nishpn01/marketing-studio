/** Independent review: stdio MCP framing, bounds, argument tricks and the fixed allowlist. Synthetic data only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalTools } from '../../src/local-tools.ts';
import { handle, serve, MAX_LINE, parseArgs } from '../../src/mcp-stdio.ts';
import { REPO_ROOT } from '../../src/runner.ts';
import { bizWs } from '../adversarial/harness.ts';

const call = (name: string, args: object, id: number | string = 1) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const out = (r: any) => JSON.parse(r.result.content[0].text);

function harness(tools: ReturnType<typeof createLocalTools>) {
  const input = new PassThrough(); const lines: any[] = []; let partial = '';
  serve(tools, input as any, (s: string) => { partial += s; for (let i; (i = partial.indexOf('\n')) >= 0;) { lines.push(JSON.parse(partial.slice(0, i))); partial = partial.slice(i + 1); } return true; });
  return { input, lines };
}
const tick = () => new Promise(r => setImmediate(r));

test('CONTROL: allowlist is fixed at start; a request cannot widen it, rename the workspace or use inherited names', () => {
  const b = bizWs(); const tools = createLocalTools(b.ws, ['context_search']);
  assert.deepEqual(out(handle(tools, call('session_start', { idea: 'A long enough idea to be valid' })) as any), { error: 'DENIED' });
  for (const name of ['__proto__', 'constructor', 'toString', 'session_start ', 'SESSION_START', '../session_start']) assert.deepEqual(out(handle(tools, call(name, {})) as any), { error: 'INVALID_REQUEST' }, name);
  // extra argument keys (workspace override attempts) are rejected, including own "__proto__" from JSON
  for (const extra of ['{"query":"x y","workspace":"/tmp"}', '{"query":"x y","__proto__":{"polluted":1}}', '{"query":"x y","allowed":["session_start"]}']) {
    const line = `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"context_search","arguments":${extra}}}`;
    assert.deepEqual(out(handle(tools, line) as any), { error: 'INVALID_REQUEST' }, extra);
  }
  assert.equal(({} as any).polluted, undefined);
  // tools/list shows only the allowed tool and cannot be mutated by callers
  const l: any = handle(tools, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { allowed: ['session_start'] } }));
  assert.deepEqual(l.result.tools.map((t: any) => t.name), ['context_search']);
  // initialize/ping carry no side effects; unknown methods and batches are errors
  assert.equal((handle(tools, '[{"jsonrpc":"2.0","id":1,"method":"ping"}]') as any).error.code, -32600);
  assert.equal((handle(tools, '{"jsonrpc":"2.0","id":1,"method":"resources/read"}') as any).error.code, -32601);
});

test('CONTROL: a tools/call sent as a notification (no id) executes nothing', () => {
  const b = bizWs(); const tools = createLocalTools(b.ws, ['session_start']);
  assert.equal(handle(tools, JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'session_start', arguments: { idea: 'Notification smuggling attempt idea', slug: 'smuggled-sess' } } })), null);
  assert.ok(!existsSync(join(b.ws, 'sessions', 'smuggled-sess')));
});

test('CONTROL: oversized lines are rejected once, do not desync framing and do not grow the buffer; next valid request still works', async () => {
  const b = bizWs(); const { input, lines } = harness(createLocalTools(b.ws, ['context_search']));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(MAX_LINE + 10) } }) + '\n'); await tick();          // complete oversized line in one chunk
  input.write('y'.repeat(MAX_LINE * 3)); await tick();                                                                                     // oversized, no newline yet
  input.write('z'.repeat(MAX_LINE * 3)); await tick();                                                                                     // still the same line
  input.write('\n' + JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n'); await tick();                                      // recovery
  assert.deepEqual(lines.map(l => l.error?.message ?? (l.id === 9 ? 'pong' : '?')), ['Request too large', 'Request too large', 'pong']);
});

test('CONTROL: context_search over a 190KB / 4000-section approved doc stays fast (the synchronous handler is not a practical DoS here)', () => {
  const big = '# Doc\n\n' + Array.from({ length: 4000 }, (_, i) => `## Section ${i}\n` + 'reminder tools library late return '.repeat(40)).join('\n');
  const b = bizWs([{ id: 'big', path: '${DOCS}/big.md', visibility: 'approved', description: 'big' }], { 'big.md': big.slice(0, 190_000) });
  const tools = createLocalTools(b.ws, ['context_search']);
  const s = Date.now(); const r = out(handle(tools, call('context_search', { query: 'reminder tools library late return policy overdue notice volunteer', limit: 20 })) as any);
  const ms = Date.now() - s;
  assert.ok(Array.isArray(r.results)); assert.ok(ms < 2000, `took ${ms} ms`);
});

test('CONTROL: real process: argument parsing is strict and the binary refuses to start without an explicit tool list', async () => {
  assert.throws(() => parseArgs(['--workspace', '/x']), /Usage/);
  assert.throws(() => parseArgs(['--tools', 'a']), /Usage/);
  const b = bizWs();
  const bad = spawn(join(REPO_ROOT, 'studio-runner/bin/studio-mcp'), ['--workspace', b.ws, '--tools', 'session_start,rm_rf']);
  const code = await new Promise<number | null>(r => bad.on('exit', r)); assert.equal(code, 2);
  const p = spawn(join(REPO_ROOT, 'studio-runner/bin/studio-mcp'), ['--workspace', b.ws, '--tools', 'context_search']);
  let buf = ''; p.stdout.on('data', d => buf += d);
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n' + call('session_start', { idea: 'Should be denied by policy' }, 'a') + '\n' + 'x'.repeat(200_000) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
  await new Promise(r => setTimeout(r, 1200)); p.stdin.end(); p.kill();
  const resp = buf.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(resp[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(out(resp[1]), { error: 'DENIED' });
  assert.equal(resp[2].error.message, 'Request too large');
  assert.deepEqual(resp[3].result, {});
  assert.ok(!existsSync(join(b.ws, 'sessions')) || readdirSync(join(b.ws, 'sessions')).length === 0);
});

test('REPRO F-MCP-2: when session_start IS allowlisted there is no rate or count limit; each call creates files on disk', () => {
  const b = bizWs(); const tools = createLocalTools(b.ws, ['session_start']);
  for (let i = 0; i < 50; i++) assert.equal(out(handle(tools, call('session_start', { idea: `Synthetic flood idea number ${i} for review`, slug: `flood-${String(i).padStart(3, '0')}` })) as any).state, 'discussing');
  assert.equal(readdirSync(join(b.ws, 'sessions')).length, 50);
});
