/**
 * Flaw-to-fix handoff. While working on content, the owner and Director find a flaw in one asset, the business's
 * guidance or knowledge, a shared Core method, or Runner/tool code. This records a source-linked proposal tied to
 * the content session, issues a handoff brief to an engineering host when the fix is code or shared methods,
 * records the tested change, records the owner's decision, and lets the newsletter continue. It never edits
 * Core, merges, publishes or widens permissions; direct invocation of an engineering worker is not implemented.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RunnerFailure, REPO_ROOT, hash, now, atomicWrite } from './runner.ts';
import { skillPins } from './agent-run.ts';
import { loadBusiness, loadSession, saveSession } from './director-session.ts';
import { loadCapture } from './conversation-capture.ts';

export const SCOPES = ['asset', 'business_guidance', 'business_knowledge', 'shared_method', 'runner_code'] as const;
type Scope = typeof SCOPES[number];
const GLOBAL: Scope[] = ['shared_method', 'runner_code'];
const ENGINEERING: Scope[] = ['business_knowledge', 'shared_method', 'runner_code'];

/** Infer the scope from what the fix would touch. `core:` paths are in the reusable Core repo; others are in the business workspace. */
export function classify(paths: string[], catalogIds: string[]): Scope | null {
  const kinds = new Set(paths.map(p => {
    if (/^core:(packs|studio-runner\/roles)\//.test(p) || /^core:(skills|specialists|core)\//.test(p)) return 'shared_method';
    if (/^core:(studio-runner\/(src|bin|test)|tools|tests)\//.test(p)) return 'runner_code';
    if (/^core:/.test(p)) return 'shared_method';
    if (/^(context\/|studio-context\.json$)/.test(p)) return 'business_guidance';
    if (/^catalog:/.test(p) && catalogIds.includes(p.slice(8))) return 'business_knowledge';
    if (/^run:/.test(p)) return 'asset';
    return 'unknown';
  }));
  if (!kinds.size || kinds.has('unknown') || kinds.size > 1) return null;
  return [...kinds][0] as Scope;
}
const impDir = (root: string, id: string) => { if (!/^imp-[0-9a-f]{10}$/.test(id)) throw new RunnerFailure('INPUT', 'Improvement ids look like imp-<10 hex>'); return join(root, 'improvements', id); };
function loadImp(root: string, id: string) { const f = join(impDir(root, id), 'proposal.json'); if (!existsSync(f)) throw new RunnerFailure('NOT_FOUND', `No improvement ${id} in this workspace`); return JSON.parse(readFileSync(f, 'utf8')); }
function saveImp(root: string, p: any, event: string, detail?: object) {
  p.history.push({ at: now(), event, ...(detail ?? {}) });
  atomicWrite(join(impDir(root, p.id), 'proposal.json'), JSON.stringify(p, null, 2));
  const s = loadSession(root, p.origin.session);
  s.improvements = (s.improvements ?? []).filter(x => x.id !== p.id).concat([{ id: p.id, scope: p.scope, status: p.status }]);
  saveSession(root, s, `improvement_${event}`, p.id);
}

/** Validate every reference so a proposal can't point at evidence that doesn't exist. */
function checkRef(root: string, s: any, ref: { kind: string; ref: string }): string {
  const runDir = s.run_id ? join(root, '.studio', 'artifacts', s.run_id) : null;
  switch (ref?.kind) {
    case 'session_artifact': {
      if (!runDir || !/^[\w.-]+$/.test(ref.ref) || !existsSync(join(runDir, ref.ref))) throw new RunnerFailure('INPUT', 'Run artifact not found');
      const base = realpathSync(join(root, '.studio', 'artifacts')), run = realpathSync(runDir), f = realpathSync(join(run, ref.ref));
      if (!run.startsWith(base + sep) || !f.startsWith(run + sep)) throw new RunnerFailure('PERMISSION', 'Run artifact resolves outside its permitted root');
      return hash(readFileSync(f));
    }
    case 'evidence': { const e = s.evidence.find((x: any) => x.path === ref.ref); if (!e) throw new RunnerFailure('INPUT', `Not evidence in this session: ${ref.ref}`); return e.sha256; }
    case 'capture_item': { const [cap, item] = ref.ref.split('#'); const t = loadCapture(root, cap); if (!/^(ci-\d+|m\d+)$/.test(item ?? '')) throw new RunnerFailure('INPUT', 'capture_item refs look like cap-<id>#ci-<n> or #m<n>'); if (item.startsWith('m') && !t.messages.some((m: any) => `m${m.i}` === item)) throw new RunnerFailure('INPUT', `No message ${item}`); return t.content_sha256; }
    case 'file': {
      const base = realpathSync(ref.ref.startsWith('core:') ? REPO_ROOT : root);
      const path = ref.ref.startsWith('core:') ? ref.ref.slice(5) : ref.ref;
      if (!path || isAbsolute(path) || path.includes('..') || !existsSync(join(base, path))) throw new RunnerFailure('INPUT', 'File reference is invalid or unavailable');
      const f = realpathSync(join(base, path));
      if (!f.startsWith(base + sep)) throw new RunnerFailure('PERMISSION', 'File reference resolves outside its permitted root');
      return hash(readFileSync(f));
    }
    case 'url': if (!/^https?:\/\/\S+$/.test(ref.ref)) throw new RunnerFailure('INPUT', `Bad URL: ${ref.ref}`); return 'n/a';
    default: throw new RunnerFailure('INPUT', 'references[].kind must be session_artifact, evidence, capture_item, file or url');
  }
}

/** A remote URL may embed a token (https://user:token@host/...); never copy credentials into a brief. */
export const stripUserinfo = (u: string) => u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
export function improvementPropose(workspaceArg: string, slug: string, file: string, reportedBy: string) {
  const root = realpathSync(resolve(workspaceArg)); const b = loadBusiness(root); const s = loadSession(root, slug);
  if (!/^[a-z0-9-]+:[A-Za-z0-9_.-]+$/.test(reportedBy)) throw new RunnerFailure('INPUT', 'reported-by must look like host:tool');
  let p: any; try { p = JSON.parse(readFileSync(resolve(file), 'utf8')); } catch { throw new RunnerFailure('INPUT', 'Proposal file is not valid JSON'); }
  if (typeof p.owner_request !== 'string' || p.owner_request.trim().length < 10) throw new RunnerFailure('PERMISSION', 'A proposal needs owner_request: the owner\'s own words asking to investigate or fix this');
  for (const k of ['title', 'finding', 'proposed_change']) if (typeof p[k] !== 'string' || p[k].trim().length < 10) throw new RunnerFailure('INPUT', `Proposal needs ${k} (at least 10 characters)`);
  if (!Array.isArray(p.affected) || !p.affected.length || !p.affected.every((x: unknown) => typeof x === 'string')) throw new RunnerFailure('INPUT', 'Proposal needs affected[]: core:<path>, context/<file>, catalog:<id> or run:<artifact>');
  const inferred = classify(p.affected, b.catalog.map(c => c.id));
  if (!inferred) throw new RunnerFailure('INPUT', 'affected[] mixes scopes or names an unknown target; split it into one proposal per scope');
  if (p.scope !== undefined && p.scope !== inferred) throw new RunnerFailure('INPUT', `scope "${p.scope}" doesn't match what the fix touches; affected[] implies "${inferred}"`);
  const scope = inferred;
  if (GLOBAL.includes(scope) && (!Array.isArray(p.tests_required) || !p.tests_required.length)) throw new RunnerFailure('INPUT', `A ${scope} change affects every business; list tests_required (including a regression on at least two different assets)`);
  if (!Array.isArray(p.references) || !p.references.length) throw new RunnerFailure('INPUT', 'Proposal needs references[] to the evidence of the flaw');
  const references = p.references.map((r: any) => ({ kind: r.kind, ref: r.ref, sha256: checkRef(root, s, r) }));
  const origin = { session: slug, session_state: s.state, run_id: s.run_id, direction_sha256: s.direction ? hash(JSON.stringify(s.direction)) : null,
    version: s.run_id && existsSync(join(root, '.studio', 'artifacts', s.run_id, 'run-snapshot.json')) ? JSON.parse(readFileSync(join(root, '.studio', 'artifacts', s.run_id, 'run-snapshot.json'), 'utf8')).current_version : null };
  const id = `imp-${hash(JSON.stringify({ slug, title: p.title, at: now() })).slice(0, 10)}`;
  const rec = { schema_version: 'studio.improvement/0.1', id, title: p.title.trim(), finding: p.finding.trim(), scope, affected: p.affected, references, proposed_change: p.proposed_change.trim(),
    tests_required: p.tests_required ?? [], risk: typeof p.risk === 'string' ? p.risk : '', owner_request: { quote: p.owner_request.trim(), authenticated: false }, reported_by: reportedBy,
    requires: scope === 'asset' ? 'a revision of this run, then the normal owner approval' : GLOBAL.includes(scope) ? 'an engineering change on a branch, passing tests (including a cross-asset regression), and owner review; never merged by the Studio' : 'an owner-made change to the business workspace or source, then owner review',
    origin, status: 'proposed', handoffs: [], change: null, decision: null, history: [] as any[] };
  saveImp(root, rec, 'proposed');
  return { id, scope, status: rec.status, requires: rec.requires, origin };
}

/** Write a self-contained brief for an engineering host. Issuing it starts nothing: direct invocation is not implemented. */
export function improvementHandoff(workspaceArg: string, id: string, target: string) {
  const root = realpathSync(resolve(workspaceArg)); loadBusiness(root); const p = loadImp(root, id);
  if (!['claude-code', 'codex'].includes(target)) throw new RunnerFailure('INPUT', 'target must be claude-code or codex');
  if (!ENGINEERING.includes(p.scope)) throw new RunnerFailure('INPUT', `${p.scope} findings are fixed in the content session or business workspace, not by an engineering handoff`);
  if (!['proposed', 'handoff_issued'].includes(p.status)) throw new RunnerFailure('INPUT', `Handoff only from proposed or handoff_issued (is ${p.status})`);
  const git = (a: string[]) => { const r = spawnSync('git', ['-C', REPO_ROOT, ...a], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : 'unknown'; };
  const core = { branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), commit: git(['rev-parse', 'HEAD']), remote: stripUserinfo(git(['remote', 'get-url', 'origin'])) };
  const where = p.scope === 'business_knowledge' ? `the repository that holds the business source named in affected[] (${p.affected.join(', ')})` : `Marketing Studio Core (${core.remote}), starting from branch \`${core.branch}\` at \`${core.commit}\``;
  const brief = `# Engineering handoff: ${p.title}

Improvement \`${p.id}\` · scope **${p.scope}** · target host: ${target} · issued ${now()}
Requested by the owner: "${p.owner_request.quote}"

## Finding
${p.finding}

## Evidence (verify each before changing anything)
${p.references.map((r: any) => `- ${r.kind}: ${r.ref}${r.sha256 !== 'n/a' ? ` (sha256 ${r.sha256.slice(0, 12)})` : ''}`).join('\n')}

## Proposed change
${p.proposed_change}

Affected: ${p.affected.join(', ')}
${p.risk ? `Risk: ${p.risk}\n` : ''}
## Where to work
${where}. Make the change on a **new branch** and open a **draft pull request**.

## Tests required before review
${(p.tests_required.length ? p.tests_required : ['Show the flaw is fixed with a test or a before/after check']).map((t: string) => `- ${t}`).join('\n')}
- The repository's full test suite and type check must pass.

## Rules
- Do not merge, tag, deploy, publish or change permissions. The owner reviews and decides.
- Do not edit files outside the affected paths, or files owned by other open pull requests.
- If the finding turns out to be wrong, say so with evidence instead of changing code.

## Report back (in the content workspace)
\`studio improvement-record --workspace <business workspace> --id ${p.id} --change <draft PR URL or commit> --tests "<command> => <result>"\`

The originating newsletter session is \`${p.origin.session}\` (run ${p.origin.run_id ?? 'none'}, version ${p.origin.version ?? 'none'}). It keeps its approved direction and evidence; after the fix it continues with \`studio session-rerun\` or \`revise\`.
`;
  const name = `handoff-${target}.md`;
  atomicWrite(join(impDir(root, id), name), brief);
  p.handoffs.push({ target, file: `improvements/${id}/${name}`, sha256: hash(brief), at: now(), core, direct_invocation: 'not implemented: the owner or host starts the engineering session with this brief' });
  p.status = 'handoff_issued'; saveImp(root, p, 'handoff_issued', { target });
  return { id, status: p.status, handoff: `improvements/${id}/${name}`, direct_invocation: 'not implemented' };
}

/** Record the change that was made. Shared and code changes must show test evidence. */
export function improvementRecord(workspaceArg: string, id: string, change: string, tests: string, resolvedVersion?: string) {
  const root = realpathSync(resolve(workspaceArg)); loadBusiness(root); const p = loadImp(root, id);
  if (!['proposed', 'handoff_issued'].includes(p.status)) throw new RunnerFailure('INPUT', `Can only record a change on an open proposal (is ${p.status})`);
  if (ENGINEERING.includes(p.scope) && p.status !== 'handoff_issued') throw new RunnerFailure('INPUT', 'Issue the engineering handoff before recording its change');
  if (typeof change !== 'string' || !/^(https?:\/\/\S+|[0-9a-f]{7,40}|[\w./-]{3,})$/.test(change)) throw new RunnerFailure('INPUT', 'change must be a PR URL, commit SHA or changed file path');
  if ((GLOBAL.includes(p.scope) || p.scope === 'business_knowledge') && (typeof tests !== 'string' || !/=>/.test(tests))) throw new RunnerFailure('INPUT', 'Record the test evidence as "<command> => <result>"');
  if (p.scope === 'asset') {
    const s = loadSession(root, p.origin.session);
    if (!resolvedVersion || !/^v\d{3}$/.test(resolvedVersion) || resolvedVersion <= (p.origin.version ?? 'v000') || !s.run_id || !existsSync(join(root, '.studio', 'artifacts', s.run_id, `draft-${resolvedVersion}.md`)))
      throw new RunnerFailure('INPUT', `An asset fix is a newer version of the draft than ${p.origin.version}; pass --version vNNN after revising`);
  }
  p.change = { ref: change, tests: tests ?? '', resolved_version: resolvedVersion ?? null, recorded_at: now() }; p.status = 'implemented';
  saveImp(root, p, 'implemented', { change });
  return { id, status: p.status, next: GLOBAL.includes(p.scope) ? 'Owner reviews the draft PR and tests, then improvement-decide' : 'Owner reviews, then improvement-decide' };
}

/** The owner's decision, in their words. Approval records a decision; it merges and changes nothing. */
export function improvementDecide(workspaceArg: string, id: string, decision: string, ownerQuote: string) {
  const root = realpathSync(resolve(workspaceArg)); loadBusiness(root); const p = loadImp(root, id);
  if (decision !== 'approve' && decision !== 'reject') throw new RunnerFailure('INPUT', 'decision must be approve or reject');
  if (typeof ownerQuote !== 'string' || ownerQuote.trim().length < 3) throw new RunnerFailure('PERMISSION', 'The decision needs the owner\'s own words');
  if (decision === 'approve' && p.status !== 'implemented') throw new RunnerFailure('INPUT', `Only an implemented, tested change can be approved (is ${p.status})`);
  if (decision === 'reject' && !['proposed', 'handoff_issued', 'implemented'].includes(p.status)) throw new RunnerFailure('INPUT', `Nothing open to reject (is ${p.status})`);
  p.decision = { decision, quote: ownerQuote.trim(), at: now(), authenticated: false, effect: decision === 'approve' && GLOBAL.includes(p.scope) ? 'improvement decision recorded; merging requires separate owner authorization' : 'recorded' };
  p.status = decision === 'approve' ? 'approved' : 'rejected'; saveImp(root, p, p.status);
  return { id, status: p.status, effect: p.decision.effect };
}

/** Close the loop and say how the original newsletter continues. Its direction and evidence are untouched. */
/** A change is only 'in effect' when its recorded commit is reachable from this checkout's HEAD and the pinned rule files are clean. A PR URL or a file path alone proves nothing. */
export function changeInEffect(ref: string | undefined): { ok: boolean; why: string } {
  if (!ref || !/^[0-9a-f]{7,40}$/.test(ref)) return { ok: false, why: 'the recorded change is not a commit SHA, so it cannot be checked against this checkout' };
  const r = spawnSync('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: REPO_ROOT });
  if (r.status !== 0) return { ok: false, why: 'the recorded commit is not reachable from this checkout\'s HEAD' };
  const dirty = skillPins().dirty;
  return dirty.length ? { ok: false, why: `pinned rule files have uncommitted changes (${dirty.slice(0, 3).join(', ')})` } : { ok: true, why: '' };
}
export function improvementClose(workspaceArg: string, id: string) {
  const root = realpathSync(resolve(workspaceArg)); loadBusiness(root); const p = loadImp(root, id);
  if (!['approved', 'rejected'].includes(p.status)) throw new RunnerFailure('INPUT', `Close after the owner decides (is ${p.status})`);
  const s = loadSession(root, p.origin.session);
  const directionUnchanged = !p.origin.direction_sha256 || (s.direction && hash(JSON.stringify(s.direction)) === p.origin.direction_sha256);
  p.status = 'closed'; saveImp(root, p, 'closed');
  const pinsMayChange = p.decision.decision === 'approve' && ['shared_method', 'business_guidance'].includes(p.scope);
  return { id, status: 'closed', session: s.slug, session_state: s.state, direction_unchanged: directionUnchanged,
    next: p.decision.decision === 'reject' ? 'Continue the newsletter as it was.' : p.scope === 'asset' ? `Continue reviewing ${p.change.resolved_version}.`
      : (p.scope === 'shared_method' || p.scope === 'runner_code') && p.decision.decision === 'approve' && !changeInEffect(p.change?.ref).ok ? `The change is NOT yet in effect: ${changeInEffect(p.change?.ref).why}. Record the merged commit SHA once it is reachable from this checkout with clean pinned files, then run: studio session-rerun --session ${s.slug} --reason "<why>"`
      : pinsMayChange ? `The recorded commit is in this checkout and the pinned files are clean, so pinned skills differ, so revise is blocked for run ${s.run_id}. Run: studio session-rerun --session ${s.slug} --reason "<why>"`
      : p.scope === 'runner_code' ? `Runner code is not pinned: once the fix is in this checkout, revise run ${s.run_id} to use it, or start clean with: studio session-rerun --session ${s.slug} --reason "<why>"`
      : 'Re-run or revise once the corrected source is in place.' };
}

export function improvementList(workspaceArg: string, slug?: string) {
  const root = realpathSync(resolve(workspaceArg)); loadBusiness(root);
  const dir = join(root, 'improvements'); if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(x => /^imp-[0-9a-f]{10}$/.test(x)).map(x => loadImp(root, x)).filter(p => !slug || p.origin.session === slug)
    .map(p => ({ id: p.id, title: p.title, scope: p.scope, status: p.status, session: p.origin.session, handoffs: p.handoffs.map((h: any) => h.file), change: p.change?.ref ?? null }));
}
