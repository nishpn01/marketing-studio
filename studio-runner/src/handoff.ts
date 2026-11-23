/**
 * Portable handoff check (acceptance R22): can a model with no prior conversation reconstruct a run's
 * state from the two portable files alone? Read-only for the run: no state change, no draft change.
 */
import { readFileSync, lstatSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { RunnerFailure, hash, now, record, atomicWrite, openWorkspace, withWorkspaceLock, get } from './runner.ts';
import { parseJson, modelFor } from './model-port.ts';
import type { ModelPort } from './model-port.ts';
import { isAgentRequest, loadSources, validateAgentRequest, defang } from './agent-run.ts';

export const HANDOFF_SYSTEM = `You are taking over a draft-only newsletter run from another system. You have no prior conversation and no other files. Use only the two documents provided. Do not guess; if a field is not stated, use null. Return ONLY one JSON object with exactly these keys:
{"run_id":string,"state":string,"current_version":string,"current_digest":string,"blocker_ids":[string],"approved_digest":string|null,"publication_authorized":boolean,"next_action":string,"owner_must_decide":[string]}`;

export function handoffPrompt(snapshot: string, pkg: string) {
  return `<file name="run-snapshot.json">\n${defang(snapshot)}\n</file>\n\n<file name="review-package.md">\n${defang(pkg)}\n</file>`;
}
export function expectedHandoff(snapshot: any) {
  return { run_id: snapshot.run_id, state: snapshot.state, current_version: snapshot.current_version, current_digest: snapshot.current_digest,
    blocker_ids: [...(snapshot.blockers ?? [])].sort(), approved_digest: snapshot.approved_digest ?? null, publication_authorized: snapshot.publication_authorized === true };
}
/** Deterministic scoring of the structured fields. next_action and owner_must_decide are recorded for a human to read, not scored. */
export function scoreHandoff(answer: any, expected: ReturnType<typeof expectedHandoff>) {
  const got = { ...answer, blocker_ids: Array.isArray(answer?.blocker_ids) ? [...answer.blocker_ids].sort() : answer?.blocker_ids };
  const fields = Object.keys(expected) as (keyof typeof expected)[];
  const results = Object.fromEntries(fields.map(f => [f, JSON.stringify(got?.[f] ?? null) === JSON.stringify(expected[f])]));
  return { fields: results, all_pass: Object.values(results).every(Boolean) };
}
/** For agent runs, a portable file must match the digest recorded when the Runner last wrote it. */
function portable(db: DatabaseSync, id: string, dir: string, name: string, agent: boolean): string {
  const f = join(dir, name);
  if (lstatSync(f).isSymbolicLink()) throw new RunnerFailure('SOURCE', `Run file is unsafe: ${name}`);
  const text = readFileSync(f, 'utf8');
  if (agent) {
    const rec = (db.prepare('SELECT details_json FROM events WHERE run_id=? AND event_type=? ORDER BY id').all(id, 'artifact') as { details_json: string }[]).map(e => JSON.parse(e.details_json)).filter(e => e.name === name).pop();
    if (!rec || rec.sha256 !== hash(text)) throw new RunnerFailure('SOURCE', `Run file changed after it was recorded: ${name}`);
  }
  return text;
}
export function handoffCheck(workspaceArg: string, id: string, providerModel: string, opts: { model?: ModelPort; provider?: string } = {}) {
  const { root, db } = openWorkspace(workspaceArg);
  try { return withWorkspaceLock(root, () => {
    const request = JSON.parse(get(db, id).request_json);
    if (isAgentRequest(request)) loadSources(root, validateAgentRequest(request));
    const dir = join(root, '.studio', 'artifacts', id);
    const agent = isAgentRequest(request);
    const snapText = portable(db, id, dir, 'run-snapshot.json', agent), pkgText = portable(db, id, dir, 'review-package.md', agent);
    const model = opts.model ?? modelFor(opts.provider ?? 'claude-code-cli');
    const prompt = handoffPrompt(snapText, pkgText);
    let res;
    try { res = model.invoke({ role: 'handoff_reader', model: providerModel, system: HANDOFF_SYSTEM, prompt }); }
    catch (e) { throw new RunnerFailure('PROVIDER', e instanceof Error ? e.message : String(e)); }
    let answer: unknown = null, parse_error: string | null = null;
    try { answer = parseJson(res.text); } catch (e) { parse_error = (e as Error).message; }
    const expected = expectedHandoff(JSON.parse(snapText));
    const score = answer ? scoreHandoff(answer, expected) : { fields: {}, all_pass: false };
    const at = now();
    const out = { schema_version: 'studio.handoff-check/0.1', run_id: id, at, inputs: { 'run-snapshot.json': hash(snapText), 'review-package.md': hash(pkgText) },
      reader: { provider: res.provider, model_id: res.model_id, live: res.live, usage: res.usage, request_id: res.request_id, context: 'fresh invocation; only the two files above' },
      expected, answer, parse_error, score };
    const name = `handoff-check-${at.replace(/[:.]/g, '-')}.json`;
    atomicWrite(join(dir, name), JSON.stringify(out, null, 2));
    record(db, id, 'handoff_check', { file: name, provider: res.provider, model_id: res.model_id, live: res.live, all_pass: score.all_pass });
    return { run_id: id, file: name, reader: out.reader.model_id, live: res.live, ...score };
  }); } finally { db.close(); }
}

/** Score an answer produced elsewhere (e.g. pasted into ChatGPT or Codex) against the run's snapshot. No model call. */
export function handoffScoreFile(workspaceArg: string, id: string, answerFile: string) {
  const { root, db } = openWorkspace(workspaceArg);
  try {
    get(db, id);
    const dir = join(root, '.studio', 'artifacts', id);
    const expected = expectedHandoff(JSON.parse(readFileSync(join(dir, 'run-snapshot.json'), 'utf8')));
    let answer: unknown; try { answer = parseJson(readFileSync(answerFile, 'utf8')); } catch (e) { throw new RunnerFailure('INPUT', 'Answer is not JSON: ' + (e as Error).message); }
    return { run_id: id, reader: 'external (unverified host; recorded by the operator)', ...scoreHandoff(answer, expected) };
  } finally { db.close(); }
}
/** Print the exact portable prompt, for pasting into another host. */
export function handoffPromptFor(workspaceArg: string, id: string) {
  const { root, db } = openWorkspace(workspaceArg);
  try { const request = JSON.parse(get(db, id).request_json);
    if (isAgentRequest(request)) loadSources(root, validateAgentRequest(request));
    const dir = join(root, '.studio', 'artifacts', id);
    const agent = isAgentRequest(request);
    return { system: HANDOFF_SYSTEM, user: handoffPrompt(portable(db, id, dir, 'run-snapshot.json', agent), portable(db, id, dir, 'review-package.md', agent)) };
  } finally { db.close(); }
}
