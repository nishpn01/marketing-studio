/**
 * Scoped disclosure of RESTRICTED SOURCES to model roles (studio.source-disclosure/0.1).
 * A grant is a local operator assertion, not authenticated identity or production authorization (see docs/security/SCOPED-DISCLOSURE.md).
 * Model roles named in a valid grant receive ONLY the granted excerpts, never the whole source, owner quote or provenance.
 * The Runner only ever asks for purpose 'drafting'; 'publication' is never satisfiable and 'internal_read' is for host-side use.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunnerFailure, hash, now, readWorkspaceIdentity } from './runner.ts';
import { HOSTS, assertSession, makeLedger } from './disclosure-ledger.ts';

const SCHEMA = 'studio.source-disclosure/0.1';
export const SOURCE_ROLES = ['director', 'writer', 'fact_reviewer', 'craft_reviewer'];
const PURPOSES = ['internal_read', 'drafting', 'publication'];
export const MAX_EXCERPTS = 5, MIN_EXCERPT = 8, MAX_EXCERPT = 2000, MAX_TOTAL = 6000;
/** Grants expire after 30 days unless the input sets an earlier expires_at, or explicitly says `no_expiry: true`. */
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;
const L = makeLedger('source-disclosures', SCHEMA);
export type SourceInfo = { digest: string; body: string; restricted: boolean };
type Inspect = (root: string, path: string) => SourceInfo;

const deny = (code: string) => new RunnerFailure('PERMISSION', `Restricted evidence cannot be sent to model roles: scoped disclosure not valid (${code})`);
const directionSha = (root: string, session: string) => { const f = join(root, 'sessions', session, 'direction.json'); return existsSync(f) ? hash(readFileSync(f)) : null; };
const expired = (g: any) => g.expires_at !== null && (typeof g.expires_at !== 'string' || !Number.isFinite(Date.parse(g.expires_at)) || Date.parse(g.expires_at) <= Date.now());
function checkExcerpts(x: unknown, body: string): string[] {
  if (!Array.isArray(x) || x.length < 1 || x.length > MAX_EXCERPTS) throw new RunnerFailure('INPUT', `Between 1 and ${MAX_EXCERPTS} exact excerpts are required`);
  if (x.some(e => typeof e !== 'string' || e.trim().length < MIN_EXCERPT || e.length > MAX_EXCERPT) || x.reduce((n, e) => n + e.length, 0) > MAX_TOTAL || new Set(x).size !== x.length) throw new RunnerFailure('INPUT', 'Excerpts must be distinct, bounded, exact text');
  if (x.some(e => !body.includes(e))) throw new RunnerFailure('PERMISSION', 'Every excerpt must occur verbatim in the source body');
  return x;
}

/** Granting is an explicit local operator action. It never authorizes publication, and `drafting` does not imply `publication`. */
export function sourceDisclosureGrant(workspaceArg: string, inputFile: string, inspect: Inspect) {
  const root = realpathSync(resolve(workspaceArg)); const workspace = readWorkspaceIdentity(root);
  let input: any; try { input = JSON.parse(readFileSync(resolve(inputFile), 'utf8')); } catch { throw new RunnerFailure('INPUT', 'Disclosure input is not valid JSON'); }
  if (input.workspace_id !== workspace) throw new RunnerFailure('PERMISSION', 'Disclosure workspace mismatch');
  assertSession(root, input.session);
  if (!HOSTS.includes(input.host)) throw new RunnerFailure('PERMISSION', 'A named host is required');
  if (!PURPOSES.includes(input.purpose)) throw new RunnerFailure('PERMISSION', 'purpose must be internal_read, drafting or publication');
  if (!Array.isArray(input.roles) || !input.roles.length || input.roles.some((r: unknown) => !SOURCE_ROLES.includes(r as string)) || new Set(input.roles).size !== input.roles.length) throw new RunnerFailure('PERMISSION', 'roles must be a non-empty list of model roles');
  if (typeof input.owner_authorization !== 'string' || input.owner_authorization.trim().length < 10) throw new RunnerFailure('PERMISSION', 'Explicit owner authorization text is required');
  if (input.expires_at !== undefined && (typeof input.expires_at !== 'string' || !Number.isFinite(Date.parse(input.expires_at)) || Date.parse(input.expires_at) <= Date.now())) throw new RunnerFailure('PERMISSION', 'Disclosure expiry must be in the future');
  if (typeof input.source_path !== 'string' || !input.source_path.startsWith('sources/') || input.source_path.includes('..') || input.source_path.includes('\\') || input.source_path.includes('\0')) throw new RunnerFailure('INPUT', 'source_path must be relative to sources/');
  const src = inspect(root, input.source_path);
  if (!src.restricted) throw new RunnerFailure('INPUT', 'This grant is only for restricted sources');
  const excerpts = checkExcerpts(input.excerpts, src.body);
  const id = `grant-${randomUUID()}`, at = now();
  const grant = { schema_version: SCHEMA, id, workspace_id: workspace, workspace_root_sha256: hash(root), session: input.session, host: input.host, roles: [...input.roles].sort(), purpose: input.purpose,
    source_path: input.source_path, source_sha256: src.digest, direction_sha256: input.bind_direction ? directionSha(root, input.session) : null, excerpts,
    owner_authorization: input.owner_authorization.trim(), authenticated: false, expires_at: input.no_expiry === true ? null : input.expires_at ?? new Date(Date.now() + DEFAULT_TTL_MS).toISOString(), issued_at: at };
  if (input.bind_direction && !grant.direction_sha256) throw new RunnerFailure('INPUT', 'bind_direction needs an approved direction in the session');
  L.issue(root, grant, { source_path: grant.source_path, session: grant.session });
  return { grant_id: id, workspace_id: workspace, session: grant.session, source_path: grant.source_path, roles: grant.roles, host: grant.host, purpose: grant.purpose, excerpt_count: excerpts.length, authenticated: false, publication_authorized: false };
}
/** Metadata only: never excerpts or the owner's words. */
export function sourceDisclosureList(workspaceArg: string, session?: string) {
  const root = realpathSync(resolve(workspaceArg)); readWorkspaceIdentity(root);
  if (!existsSync(L.DIR(root))) return [];
  return L.audit(root).filter(e => e.event === 'issued' && (!session || e.session === session)).map(e => {
    const { grant: g, revoked } = L.loadGrant(root, e.id);
    return { grant_id: g.id, session: g.session, source_path: g.source_path, roles: g.roles, host: g.host, purpose: g.purpose, excerpt_count: g.excerpts.length, expires_at: g.expires_at, status: revoked ? 'revoked' : expired(g) ? 'expired' : 'active', authenticated: false };
  });
}
export function sourceDisclosureRevoke(workspaceArg: string, id: string, ownerQuote: string) {
  return L.revoke(realpathSync(resolve(workspaceArg)), id, ownerQuote);
}

/**
 * Revalidate every binding and return the sanitized per-role views. Any failure throws a generic error carrying only a reason code.
 * Fails closed when a required role is not covered, when two live grants cover the same role, or when anything changed.
 */
export function resolveSourceDisclosure(root: string, o: { path: string; digest: string; body: string; session?: string; host?: string; purpose: string; roles: string[] }): { views: Record<string, string>; sig: string } {
  if (o.purpose !== 'drafting') throw deny('purpose_unsupported'); // publication is never satisfiable; internal_read is not a Runner purpose
  if (!o.session || !o.host) throw deny('no_context');
  const workspace = readWorkspaceIdentity(root);
  try {
    assertSession(root, o.session);
    if (!existsSync(L.DIR(root))) throw deny('no_grant');
    const views: Record<string, string> = {}, used: Record<string, string> = {}; let failure = 'no_grant';
    for (const e of L.audit(root).filter(e => e.event === 'issued' && e.source_path === o.path)) {
      const { grant: g, revoked } = L.loadGrant(root, e.id);
      const code = revoked ? 'revoked' : expired(g) ? 'expired'
        : g.workspace_id !== workspace || g.workspace_root_sha256 !== hash(root) || g.source_path !== o.path || g.session !== o.session || g.host !== o.host || g.purpose !== o.purpose ? 'scope_mismatch'
        : g.source_sha256 !== o.digest ? 'stale_source'
        : g.direction_sha256 !== null && g.direction_sha256 !== directionSha(root, o.session) ? 'scope_mismatch'
        : !Array.isArray(g.roles) || !Array.isArray(g.excerpts) || g.excerpts.length < 1 || g.excerpts.length > MAX_EXCERPTS || g.excerpts.some((x: unknown) => typeof x !== 'string' || x.length < MIN_EXCERPT || x.length > MAX_EXCERPT || !o.body.includes(x)) ? 'excerpt_invalid' : '';
      if (code) { if (failure === 'no_grant' || code === 'stale_source') failure = code; continue; }
      for (const role of g.roles as string[]) {
        if (!SOURCE_ROLES.includes(role)) continue;
        if (role in views) throw deny('ambiguous');
        views[role] = (g.excerpts as string[]).join('\n\n'); used[role] = g.id;
      }
    }
    if (o.roles.some(r => !(r in views))) throw deny(Object.keys(views).length ? 'role_not_granted' : failure);
    return { views, sig: hash(JSON.stringify(Object.keys(views).sort().map(r => [r, used[r], hash(views[r])]))) };
  } catch (e) {
    if (e instanceof RunnerFailure && e.message.startsWith('Restricted evidence')) throw e;
    throw deny('tampered_or_unavailable'); // ledger/grant/session errors never echo their details
  }
}
