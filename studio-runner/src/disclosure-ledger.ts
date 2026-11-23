/** Shared grant files + hash-chained audit ledger for scoped disclosure. Local operator assertions only, not authenticated identity. */
import { existsSync, readFileSync, lstatSync, openSync, writeFileSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { RunnerFailure, hash, now, safeDir, atomicWrite, readWorkspaceIdentity, withWorkspaceLock } from './runner.ts';

export const HOSTS = ['codex', 'claude-code', 'chatgpt', 'claude-chat', 'other'];
export function safeFile(path: string) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new RunnerFailure('PERMISSION', 'Disclosure file is a symlink');
}
/** The session must exist as a real (non-symlink) session record. */
export function assertSession(root: string, slug: unknown) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(slug)) throw new RunnerFailure('INPUT', 'Invalid session');
  const dir = join(root, 'sessions', slug); safeDir(dir, false);
  const file = join(dir, 'session.json'); safeFile(file);
  if (!existsSync(file)) throw new RunnerFailure('NOT_FOUND', 'Session not found');
  let s: any; try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new RunnerFailure('SOURCE', 'Invalid session record'); }
  if (s.schema_version !== 'studio.session/0.1' || s.slug !== slug) throw new RunnerFailure('SOURCE', 'Invalid session record');
}

export function makeLedger(subdir: string, schema: string) {
  const DIR = (root: string) => join(root, '.studio', subdir);
  const ledger = (root: string) => join(DIR(root), 'audit.jsonl');
  const grantPath = (root: string, id: string) => {
    if (!/^grant-[0-9a-f-]{36}$/.test(id)) throw new RunnerFailure('INPUT', 'Invalid disclosure grant ID');
    return join(DIR(root), `${id}.json`);
  };
  function audit(root: string): any[] {
    safeDir(DIR(root), false); const path = ledger(root); safeFile(path);
    if (!existsSync(path)) return [];
    const content = readFileSync(path, 'utf8');
    if (content.length > 5_000_000 || (content && !content.endsWith('\n'))) throw new RunnerFailure('SOURCE', 'Invalid disclosure audit');
    let events: any[];
    try { events = content.trim() ? content.trim().split('\n').map(line => JSON.parse(line)) : []; } catch { throw new RunnerFailure('SOURCE', 'Invalid disclosure audit'); }
    let previous: string | null = null;
    for (const [index, e] of events.entries()) {
      const { sha256, ...payload } = e;
      if (payload.seq !== index + 1 || payload.previous_sha256 !== previous || !['issued', 'revoked'].includes(payload.event) || sha256 !== hash(JSON.stringify(payload))) throw new RunnerFailure('SOURCE', 'Disclosure audit changed');
      previous = sha256;
    }
    return events;
  }
  function append(root: string, event: object) {
    const prior = audit(root); const payload = { seq: prior.length + 1, previous_sha256: prior.at(-1)?.sha256 ?? null, ...event };
    const record = { ...payload, sha256: hash(JSON.stringify(payload)) }; const file = ledger(root); safeFile(file);
    const fd = openSync(file, 'a', 0o600); try { writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  }
  function loadGrant(root: string, id: string) {
    safeDir(DIR(root), false); const f = grantPath(root, id); safeFile(f);
    if (!existsSync(f)) throw new RunnerFailure('NOT_FOUND', 'Disclosure grant not found');
    const raw = readFileSync(f, 'utf8'); let grant: any;
    try { grant = JSON.parse(raw); } catch { throw new RunnerFailure('SOURCE', 'Invalid disclosure grant'); }
    const events = audit(root).filter(e => e.id === id); const issued = events.filter(e => e.event === 'issued');
    if (issued.length !== 1 || issued[0].grant_sha256 !== hash(raw) || grant.id !== id || grant.schema_version !== schema) throw new RunnerFailure('SOURCE', 'Disclosure grant changed');
    const marker = join(DIR(root), `${id}.revoked.json`); safeFile(marker);
    return { grant, revoked: existsSync(marker) || events.some(e => e.event === 'revoked') };
  }
  /** Write the grant file and append its 'issued' event under the workspace lock. `extra` goes in the (non-private) ledger event. */
  function issue(root: string, grant: { id: string; issued_at: string }, extra: object = {}) {
    safeDir(join(root, '.studio'));
    withWorkspaceLock(root, () => {
      safeDir(DIR(root)); const target = grantPath(root, grant.id); safeFile(target);
      if (existsSync(target)) throw new RunnerFailure('INPUT', 'Grant ID already exists');
      const raw = JSON.stringify(grant, null, 2); atomicWrite(target, raw);
      append(root, { event: 'issued', id: grant.id, at: grant.issued_at, grant_sha256: hash(raw), ...extra });
    });
  }
  function revoke(root: string, id: string, ownerQuote: string) {
    readWorkspaceIdentity(root);
    if (typeof ownerQuote !== 'string' || ownerQuote.trim().length < 10) throw new RunnerFailure('PERMISSION', 'Explicit owner revocation text is required');
    safeDir(join(root, '.studio'), false);
    if (!existsSync(DIR(root))) throw new RunnerFailure('NOT_FOUND', 'Disclosure grant not found');
    return withWorkspaceLock(root, () => {
      const { grant, revoked } = loadGrant(root, id); if (revoked) throw new RunnerFailure('INPUT', 'Disclosure grant already revoked');
      if (grant.workspace_id !== readWorkspaceIdentity(root) || grant.workspace_root_sha256 !== hash(root)) throw new RunnerFailure('PERMISSION', 'Disclosure workspace mismatch');
      const event = { event: 'revoked', id, at: now(), owner_authorization: ownerQuote.trim(), authenticated: false };
      const marker = join(DIR(root), `${id}.revoked.json`); safeFile(marker); atomicWrite(marker, JSON.stringify(event));
      append(root, event);
      return { grant_id: id, revoked: true, authenticated: false };
    });
  }
  return { DIR, audit, loadGrant, issue, revoke };
}
