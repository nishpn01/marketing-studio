import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalTools } from '../src/local-tools.ts';
import { captureImport } from '../src/conversation-capture.ts';

function workspace(id: string) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-tool-'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'approved.md'), '# Approved\nA synthetic bicycle repair shop offers group workshops.');
  writeFileSync(join(dir, 'docs', 'restricted.md'), '# Private\nPRIVATE-TOOL-SENTINEL-913 never share this.');
  writeFileSync(join(dir, 'studio-business.json'), JSON.stringify({ schema_version: 'studio.business/0.1', workspace_id: id, allowed_roots: ['docs'], defaults: { audience: 'builders', provider: 'fixture', models: {}, budget: {} }, capture: { enabled: true, allowed_hosts: ['other'] }, catalog: [
    { id: 'approved', path: 'docs/approved.md', visibility: 'approved', description: 'fictional' },
    { id: 'restricted', path: 'docs/restricted.md', visibility: 'restricted', description: 'private' },
  ] }));
  return dir;
}
const req = (name: string, args: object = {}) => ({ schema_version: 'studio.tool-call/0.1', name, arguments: args });

test('fixed workspace and explicit tool policy preserve session state without cross-tenant selection', () => {
  const a = workspace('test-tenant-a'), b = workspace('test-tenant-b');
  const allowed: ('session_status' | 'session_start' | 'context_search')[] = ['session_status', 'session_start'];
  const ta = createLocalTools(a, allowed), tb = createLocalTools(b, ['session_status']); allowed.push('context_search');
  assert.deepEqual(ta.call(req('context_search', { query: 'synthetic' })), { ok: false, error: 'DENIED' });
  assert.equal(ta.call(req('session_start', { idea: 'A synthetic discussion about group workshops', slug: 'workshops' })).ok, true);
  assert.equal((ta.call(req('session_status')) as any).result.length, 1);
  assert.equal((tb.call(req('session_status')) as any).result.length, 0);
  assert.deepEqual(tb.call(req('session_status', { workspace: a })), { ok: false, error: 'INVALID_REQUEST' });
  assert.deepEqual(tb.call(req('session_start', { idea: 'A synthetic discussion about workshops' })), { ok: false, error: 'DENIED' });
  assert.deepEqual(tb.call({ ...req('session_status'), workspace: a }), { ok: false, error: 'INVALID_REQUEST' });
});

test('search and capture tools do not return restricted material, and errors do not expose inputs', () => {
  const dir = workspace('test-tenant-c');
  const file = join(dir, 'chat.txt'); writeFileSync(file, 'Owner: PRIVATE-TOOL-SENTINEL-913 is an internal decision.');
  const c = captureImport(dir, { file, host: 'other', format: 'text', authorization: 'Please import this private synthetic conversation', title: 'Private title' });
  const t = createLocalTools(dir, ['context_search', 'capture_list', 'capture_show']);
  assert.ok(!JSON.stringify(t.call(req('context_search', { query: 'private sentinel decision' }))).includes('PRIVATE-TOOL-SENTINEL-913'));
  assert.ok(!JSON.stringify(t.call(req('capture_list'))).includes('Private title'));
  assert.deepEqual(t.call(req('capture_show', { capture: c.capture_id, ref: 'm1' })), { ok: false, error: 'OPERATION_FAILED' });
  assert.deepEqual(t.call(req('context_search', { query: 'PRIVATE-TOOL-SENTINEL-913', limit: 999 })), { ok: false, error: 'INVALID_REQUEST' });
  assert.deepEqual(t.call(req('session_status')), { ok: false, error: 'DENIED' });
  assert.deepEqual(t.call(req('publish')), { ok: false, error: 'INVALID_REQUEST' });
});
