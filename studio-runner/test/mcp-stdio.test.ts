import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT } from '../src/runner.ts';
import { captureImport } from '../src/conversation-capture.ts';
import { sessionStart } from '../src/director-session.ts';

const bin = join(REPO_ROOT, 'studio-runner/bin/studio-mcp');
function workspace(id: string) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-mcp-'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'approved.md'), '# Approved\nA synthetic bicycle repair shop offers group workshops.');
  writeFileSync(join(dir, 'studio-business.json'), JSON.stringify({ schema_version: 'studio.business/0.1', workspace_id: id, allowed_roots: ['docs'], defaults: { audience: 'builders', provider: 'fixture', models: {}, budget: {} }, capture: { enabled: true, allowed_hosts: ['other'] }, catalog: [
    { id: 'approved', path: 'docs/approved.md', visibility: 'approved', description: 'fictional' }] }));
  return dir;
}
/** Send raw stdin text, return parsed response lines. */
function run(args: string[], input: string): any[] {
  const r = spawnSync(bin, args, { input, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
}
const rpc = (id: number, method: string, params?: object) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

test('protocol conformance: initialize, notification, ping, tools/list, tools/call', () => {
  const ws = workspace('mcp-a');
  const out = run(['--workspace', ws, '--tools', 'context_search,session_start'],
    rpc(1, 'initialize', { protocolVersion: '2025-03-26' }) + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' + rpc(2, 'ping') + rpc(3, 'tools/list') +
    rpc(4, 'tools/call', { name: 'context_search', arguments: { query: 'bicycle workshops' } }) + rpc(5, 'nope'));
  assert.equal(out.length, 5 - 0); // notification produces no response
  assert.equal(out[0].result.protocolVersion, '2025-03-26');
  assert.deepEqual(out[0].result.capabilities, { tools: {} });
  assert.deepEqual(out[1], { jsonrpc: '2.0', id: 2, result: {} });
  assert.deepEqual(out[2].result.tools.map((t: any) => t.name), ['context_search', 'session_start']);
  assert.equal(out[3].result.isError, false);
  assert.match(out[3].result.content[0].text, /bicycle/);
  assert.equal(out[4].error.code, -32601);
});

test('deny by default: startup needs explicit tools; unlisted tools are denied; invalid policy refuses to start', () => {
  const ws = workspace('mcp-b');
  assert.equal(spawnSync(bin, ['--workspace', ws], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(bin, ['--workspace', ws, '--tools', 'publish'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(bin, ['--tools', 'session_status'], { encoding: 'utf8' }).status, 2);
  const out = run(['--workspace', ws, '--tools', 'session_status'], rpc(1, 'tools/call', { name: 'context_search', arguments: { query: 'x' } }) + rpc(2, 'tools/call', { name: 'publish', arguments: {} }));
  assert.equal(out[0].result.isError, true); assert.match(out[0].result.content[0].text, /DENIED/);
  assert.match(out[1].result.content[0].text, /INVALID_REQUEST/);
});

test('malformed and oversized requests get generic errors and the server keeps serving', () => {
  const ws = workspace('mcp-c');
  const big = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping', pad: 'x'.repeat(70000) }) + '\n';
  const out = run(['--workspace', ws, '--tools', 'session_status'], 'not json\n' + '[1,2]\n' + '{"jsonrpc":"1.0","id":1,"method":"ping"}\n' + big + rpc(3, 'tools/call', { name: 5 }) + rpc(4, 'ping'));
  assert.deepEqual(out.map(o => o.error?.code ?? 'ok'), [-32700, -32600, -32600, -32600, -32602, 'ok']);
  assert.ok(!JSON.stringify(out).includes(ws));
});

test('workspace is fixed at start: arguments cannot change it, and errors carry no local text', () => {
  const a = workspace('mcp-d'), b = workspace('mcp-e');
  sessionStart(b, 'Synthetic private idea SENTINEL-B-77 for workshops', 'only-in-b');
  const out = run(['--workspace', a, '--tools', 'session_status,context_search'],
    rpc(1, 'tools/call', { name: 'session_status', arguments: { workspace: b } }) + rpc(2, 'tools/call', { name: 'session_status', arguments: { session: 'only-in-b' } }) + rpc(3, 'tools/call', { name: 'session_status', arguments: {} }));
  assert.match(out[0].result.content[0].text, /INVALID_REQUEST/);
  assert.match(out[1].result.content[0].text, /OPERATION_FAILED/);
  assert.equal(out[2].result.content[0].text, '[]');
  const s = JSON.stringify(out); assert.ok(!s.includes(b) && !s.includes('SENTINEL-B-77'));
});

test('session_status exposes only state and counts, not idea text or paths', () => {
  const ws = workspace('mcp-f');
  sessionStart(ws, 'Synthetic owner idea SENTINEL-IDEA-31 about workshops', 'idea-check');
  const text = run(['--workspace', ws, '--tools', 'session_status'], rpc(1, 'tools/call', { name: 'session_status', arguments: {} }))[0].result.content[0].text;
  assert.ok(!text.includes('SENTINEL-IDEA-31'));
  assert.deepEqual(JSON.parse(text), [{ session: 'idea-check', state: 'discussing', evidence_count: 0, restricted_evidence_count: 0, notes_count: 0, direction_approved: false, run: null }]);
});

test('restricted captures are never returned over MCP', () => {
  const ws = workspace('mcp-g');
  const file = join(ws, 'chat.txt'); writeFileSync(file, 'Owner: MCP-PRIVATE-SENTINEL-552 is an internal decision.');
  const c = captureImport(ws, { file, host: 'other', format: 'text', authorization: 'Please import this private synthetic conversation', title: 'Private MCP title' });
  const out = run(['--workspace', ws, '--tools', 'capture_list,capture_show,context_search'],
    rpc(1, 'tools/call', { name: 'capture_list', arguments: {} }) + rpc(2, 'tools/call', { name: 'capture_show', arguments: { capture: c.capture_id, ref: 'm1' } }) + rpc(3, 'tools/call', { name: 'context_search', arguments: { query: 'internal decision' } }));
  const s = JSON.stringify(out);
  assert.ok(!s.includes('MCP-PRIVATE-SENTINEL-552') && !s.includes('Private MCP title'), s);
  assert.match(out[1].result.content[0].text, /OPERATION_FAILED/);
});

test('server is a pure stdio process: exits on stdin close', async () => {
  const ws = workspace('mcp-h');
  const p = spawn(bin, ['--workspace', ws, '--tools', 'session_status']);
  p.stdin.end();
  await new Promise<void>((res, rej) => { const t = setTimeout(() => { p.kill(); rej(new Error('did not exit')); }, 10000); p.on('exit', () => { clearTimeout(t); res(); }); });
});
