import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../src/runner.ts';
import { captureImport } from '../src/conversation-capture.ts';
import { captureDisclosureGrant, captureDisclosureRead, captureDisclosureRevoke } from '../src/capture-disclosure.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'studio-grant-'));
  writeFileSync(join(root, 'studio-workspace.json'), JSON.stringify({ schema_version: 'studio.workspace/0.1', workspace_id: 'test-tenant' }));
  writeFileSync(join(root, 'studio-business.json'), JSON.stringify({ capture: { enabled: true, allowed_hosts: ['other'] } }));
  mkdirSync(join(root, 'sessions', 'sample-session'), { recursive: true });
  writeFileSync(join(root, 'sessions', 'sample-session', 'session.json'), JSON.stringify({ schema_version: 'studio.session/0.1', slug: 'sample-session' }));
  const captureFile = join(root, 'input.txt');
  writeFileSync(captureFile, 'Owner: We chose the blue route. PRIVATE-SENTINEL-777 Must remain confidential.\nAssistant: A different suggestion.');
  const capture = captureImport(root, { file: captureFile, host: 'other', format: 'text', authorization: 'Please capture this discussion.', title: 'Synthetic discussion' }) as any;
  const input = { workspace_id: 'test-tenant', session: 'sample-session', host: 'codex', role: 'director', purpose: 'internal_read', capture_id: capture.capture_id, message: 1,
    excerpt: 'We chose the blue route.', exclusions: ['PRIVATE-SENTINEL-777'], owner_authorization: 'You may read only this decision.' };
  const file = join(root, 'grant-input.json');
  const grant = (over: object = {}) => { writeFileSync(file, JSON.stringify({ ...input, ...over })); return captureDisclosureGrant(root, file) as any; };
  const read = (id: string, over: object = {}) => captureDisclosureRead(root, id, { session: 'sample-session', host: 'codex', role: 'director', purpose: 'internal_read', ...over });
  return { root, capture, grant, read };
}

test('scoped capture access returns only an owner-authorized excerpt, never evidence or publication rights', () => {
  const f = fixture(); const g = f.grant(); const out = f.read(g.grant_id);
  assert.equal(out.excerpt, 'We chose the blue route.');
  assert.equal(out.public_claim_permitted, false); assert.equal(out.publication_authorized, false); assert.equal(out.untrusted_data, true);
  assert.ok(!JSON.stringify(out).includes('PRIVATE-SENTINEL-777'));
  assert.throws(() => f.read(g.grant_id, { host: 'claude-code' }), /scope mismatch/);
  assert.throws(() => f.read(g.grant_id, { role: 'writer' }), /scope mismatch/);
  assert.throws(() => f.read(g.grant_id, { purpose: 'draft_use' }), /scope mismatch/);
  assert.throws(() => f.grant({ excerpt: 'PRIVATE-SENTINEL-777' }), /exclusions/);
  assert.throws(() => f.grant({ message: 2, excerpt: 'A different suggestion.' }), /owner message/);
  assert.throws(() => f.grant({ owner_authorization: 'ok' }), /authorization/);
  assert.throws(() => f.grant({ purpose: 'draft_use' }), /internal_read/);
  assert.throws(() => f.grant({ expires_at: '2000-01-01T00:00:00.000Z' }), /expiry/);
});

test('expiry and audit tampering stop subsequent reads', () => {
  const f = fixture(); const g = f.grant({ expires_at: new Date(Date.now() + 60000).toISOString() });
  const originalNow = Date.now;
  try { Date.now = () => originalNow() + 120000; assert.throws(() => f.read(g.grant_id), /expired/); } finally { Date.now = originalNow; }
  const path = join(f.root, '.studio', 'capture-disclosures', 'audit.jsonl');
  const event = JSON.parse(readFileSync(path, 'utf8')); event.id = 'grant-00000000-0000-0000-0000-000000000000';
  writeFileSync(path, JSON.stringify(event) + '\n');
  assert.throws(() => f.read(g.grant_id), /audit changed/);
});

test('revocation survives audit-tail loss; changed grants and source fail closed', () => {
  const f = fixture(); const a = f.grant();
  const dir = join(f.root, '.studio', 'capture-disclosures');
  const path = join(dir, `${a.grant_id}.json`); const original = readFileSync(path, 'utf8');
  const modified = JSON.parse(original); modified.excerpt = 'PRIVATE-SENTINEL-777'; writeFileSync(path, JSON.stringify(modified));
  assert.throws(() => f.read(a.grant_id), /grant changed/); writeFileSync(path, original);
  captureDisclosureRevoke(f.root, a.grant_id, 'Revoke this access now.');
  assert.throws(() => f.read(a.grant_id), /revoked/);
  const log = join(dir, 'audit.jsonl'); const first = readFileSync(log, 'utf8').split('\n')[0] + '\n'; writeFileSync(log, first);
  assert.throws(() => f.read(a.grant_id), /revoked/);
  const b = f.grant();
  const transcript = join(f.root, 'captures', f.capture.capture_id, 'transcript.json');
  const t = JSON.parse(readFileSync(transcript, 'utf8')); t.messages[0].text += ' changed'; writeFileSync(transcript, JSON.stringify(t));
  assert.throws(() => f.read(b.grant_id), /changed after import/);
});

test('scope cannot cross sessions or workspaces and provenance classification cannot be downgraded', () => {
  const f = fixture(); const g = f.grant();
  mkdirSync(join(f.root, 'sessions', 'other-session'), { recursive: true });
  writeFileSync(join(f.root, 'sessions', 'other-session', 'session.json'), JSON.stringify({ schema_version: 'studio.session/0.1', slug: 'other-session' }));
  assert.throws(() => f.read(g.grant_id, { session: 'other-session' }), /scope mismatch/);
  const other = fixture();
  assert.throws(() => other.read(g.grant_id), /not found/);
  cpSync(f.root, other.root, { recursive: true });
  assert.throws(() => other.read(g.grant_id), /scope mismatch/);
  const transcript = join(f.root, 'captures', f.capture.capture_id, 'transcript.json');
  const t = JSON.parse(readFileSync(transcript, 'utf8')); t.visibility = 'approved'; writeFileSync(transcript, JSON.stringify(t));
  assert.throws(() => f.read(g.grant_id), /classification or provenance changed/);
});

test('CLI returns only the bounded excerpt and fails closed after revocation', () => {
  const f = fixture(); const g = f.grant(); const cli = join(REPO_ROOT, 'studio-runner/src/cli.ts');
  const args = ['--experimental-strip-types', cli, 'capture-disclosure-read', '--workspace', f.root, '--grant', g.grant_id, '--session', 'sample-session', '--host', 'codex'];
  const before = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(before.status, 0); assert.equal(JSON.parse(before.stdout).excerpt, 'We chose the blue route.');
  assert.ok(!before.stdout.includes('PRIVATE-SENTINEL-777'));
  captureDisclosureRevoke(f.root, g.grant_id, 'Revoke this access now.');
  const after = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(after.status, 0); assert.match(after.stderr, /revoked/); assert.ok(!after.stdout.includes('PRIVATE-SENTINEL-777'));
});
