/** Deterministic capability-pack evaluation harness. Live evaluation is deliberately not implemented. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadPack, packPins } from './pack-loader.ts';
import type { CapabilityPack } from './pack-loader.ts';
import { FixtureModel } from './model-port.ts';
import type { Role } from './model-port.ts';
import { inspectRun, REPO_ROOT, RunnerFailure, hash } from './runner.ts';
import { inspectSource, startAgentRun, systemPromptForRole, validateAgentRequest } from './agent-run.ts';
import { sourceDisclosureGrant } from './source-disclosure.ts';

export const EVAL_CASE_SCHEMA = 'studio.eval-case/0.1';
export const EVAL_RESULT_SCHEMA = 'studio.eval-result/0.1';
const ROLES: Role[] = ['director', 'writer', 'fact_reviewer', 'craft_reviewer'];
const STATES_BY_ERROR: Record<string, string> = {
  INPUT: 'BLOCKED_INPUT',
  PERMISSION: 'BLOCKED_PERMISSION',
  SOURCE: 'BLOCKED_SOURCE',
  BUDGET: 'BLOCKED_BUDGET',
  QA: 'BLOCKED_QA',
  PROVIDER: 'FAILED_RECOVERABLE',
};

type JsonObject = Record<string, unknown>;
type EvalSource = { path: string; visibility: 'approved' | 'restricted'; text: string };
type EvalExpected = {
  status: string;
  blockers?: string[];
  fact_verdicts?: Record<string, number>;
  metadata_gate_exit_code?: number;
  current_version?: string;
  error_contains?: string;
};
type RubricExpectations = { draft_contains?: string[]; draft_not_contains?: string[] };
type DisclosureGrant = { source_path: string; roles: Role[]; excerpts: string[]; owner_authorization: string; expires_at?: string; no_expiry?: boolean };
type EvalCase = {
  schema_version: typeof EVAL_CASE_SCHEMA;
  id: string;
  live_only?: boolean;
  live_only_reason?: string;
  request: JsonObject;
  sources: EvalSource[];
  responses?: Partial<Record<Role, unknown[]>>;
  recorded_system_sha256?: Record<Role, string>;
  source_disclosure_grants?: DisclosureGrant[];
  expected: EvalExpected;
  rubric_expectations?: RubricExpectations;
  fixture_path: string;
  raw: string;
};

type GateResult = { version: string; exit_code: number; result?: unknown };
type CaseResult = {
  id: string;
  mode: 'replay' | 'live-only';
  pass: boolean | null;
  status: string;
  expected: EvalExpected;
  blockers: string[];
  fact_verdicts: Record<string, number>;
  gate_results: GateResult[];
  current_version: string | null;
  rubric_checks?: { pass: boolean; missing: string[]; forbidden: string[] };
  error?: { code: string | null; message: string };
  note?: string;
};

type BaselineDiff = {
  source: string;
  stale_recordings: { id: string; roles: Role[] }[];
  regressions: { id: string; baseline: boolean | null; current: boolean | null }[];
  improvements: { id: string; baseline: boolean | null; current: boolean | null }[];
  unchanged: string[];
  new_cases: string[];
  missing_cases: string[];
  fixture_expectations_changed: boolean;
  pack_pin_changed: boolean;
};

export type EvalReport = {
  schema_version: typeof EVAL_RESULT_SCHEMA;
  pack_id: string;
  pack_version: string;
  mode: 'fixture-replay';
  pack_pin: ReturnType<typeof packPins>;
  fixture_sha256: string;
  fixture_expectations_sha256: string;
  cases: CaseResult[];
  totals: { cases: number; replayed: number; passed: number; failed: number; live_only: number };
  pass: boolean;
  baseline_diff?: BaselineDiff;
  result_path: string;
  summary_path: string;
};

const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerFailure('INPUT', `${label} must be an object`);
  return value as JsonObject;
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new RunnerFailure('INPUT', `${label} must be a non-empty string`);
  return value;
};
const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new RunnerFailure('INPUT', `${label} must be an array`);
  return value;
};
const pathOK = (value: unknown): value is string => typeof value === 'string' && value.startsWith('sources/') && !value.includes('..') && !value.includes('\\') && !value.includes('\0');

function validateRubric(value: unknown, label: string): RubricExpectations | undefined {
  if (value === undefined) return undefined;
  const r = object(value, label);
  const check = (v: unknown, field: string) => {
    if (v !== undefined && (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim()))) throw new RunnerFailure('INPUT', `${label}.${field} must be an array of non-empty strings`);
  };
  check(r.draft_contains, 'draft_contains'); check(r.draft_not_contains, 'draft_not_contains');
  return { draft_contains: r.draft_contains as string[] | undefined, draft_not_contains: r.draft_not_contains as string[] | undefined };
}

function validateDisclosureGrants(value: unknown, label: string): DisclosureGrant[] | undefined {
  if (value === undefined) return undefined;
  return array(value, label).map((grant, i) => {
    const g = object(grant, `${label}[${i}]`);
    const roles = array(g.roles, `${label}[${i}].roles`).map(x => string(x, `${label}[${i}].roles[]`)) as Role[];
    if (roles.some(role => !ROLES.includes(role))) throw new RunnerFailure('INPUT', `${label}[${i}].roles contains an unsupported role`);
    const excerpts = array(g.excerpts, `${label}[${i}].excerpts`).map(x => string(x, `${label}[${i}].excerpts[]`));
    return { source_path: string(g.source_path, `${label}[${i}].source_path`), roles, excerpts, owner_authorization: string(g.owner_authorization, `${label}[${i}].owner_authorization`), expires_at: g.expires_at as string | undefined, no_expiry: g.no_expiry as boolean | undefined };
  });
}

function validateCase(raw: unknown, fixturePath: string, sourceText: string, packId: string): EvalCase {
  const c = object(raw, fixturePath);
  if (c.schema_version !== EVAL_CASE_SCHEMA) throw new RunnerFailure('INPUT', `${fixturePath} needs schema_version ${EVAL_CASE_SCHEMA}`);
  const id = string(c.id, `${fixturePath}.id`);
  const request = object(c.request, `${fixturePath}.request`);
  if (request.pack_id !== packId) throw new RunnerFailure('INPUT', `${fixturePath}.request.pack_id must be ${packId}`);
  const sources = array(c.sources, `${fixturePath}.sources`).map((source, i) => {
    const s = object(source, `${fixturePath}.sources[${i}]`);
    const path = string(s.path, `${fixturePath}.sources[${i}].path`);
    if (!pathOK(path)) throw new RunnerFailure('INPUT', `${fixturePath}.sources[${i}].path must be under sources/`);
    if (s.visibility !== 'approved' && s.visibility !== 'restricted') throw new RunnerFailure('INPUT', `${fixturePath}.sources[${i}].visibility is invalid`);
    return { path, visibility: s.visibility as EvalSource['visibility'], text: string(s.text, `${fixturePath}.sources[${i}].text`) };
  });
  const requestPaths = array(request.source_paths, `${fixturePath}.request.source_paths`).map(x => string(x, 'source path'));
  const sourcePaths = new Set(sources.map(s => s.path));
  if (requestPaths.length !== sourcePaths.size || requestPaths.some(p => !sourcePaths.has(p))) throw new RunnerFailure('INPUT', `${fixturePath} source_paths do not match sources`);
  const expected = object(c.expected, `${fixturePath}.expected`) as EvalExpected;
  expected.status = string(expected.status, `${fixturePath}.expected.status`);
  if (expected.blockers !== undefined) array(expected.blockers, `${fixturePath}.expected.blockers`);
  if (expected.fact_verdicts !== undefined) object(expected.fact_verdicts, `${fixturePath}.expected.fact_verdicts`);
  const liveOnly = c.live_only === true;
  const liveOnlyReason = c.live_only_reason;
  if (liveOnly && (typeof liveOnlyReason !== 'string' || !liveOnlyReason.trim())) throw new RunnerFailure('INPUT', `${fixturePath}.live_only_reason is required for live-only cases`);
  const rubricExpectations = validateRubric(c.rubric_expectations, `${fixturePath}.rubric_expectations`);
  const sourceDisclosureGrants = validateDisclosureGrants(c.source_disclosure_grants, `${fixturePath}.source_disclosure_grants`);
  if (sourceDisclosureGrants?.length && (!request.disclosure || typeof request.disclosure !== 'object')) throw new RunnerFailure('INPUT', `${fixturePath}.source_disclosure_grants requires request.disclosure`);
  let responses: Partial<Record<Role, unknown[]>> | undefined;
  let recordedSystemSha256: Record<Role, string> | undefined;
  if (!liveOnly) {
    const recorded = object(c.responses, `${fixturePath}.responses`);
    const hashes = object(c.recorded_system_sha256, `${fixturePath}.recorded_system_sha256`);
    recordedSystemSha256 = {} as Record<Role, string>;
    responses = {};
    for (const role of ROLES) {
      const systemSha = string(hashes[role], `${fixturePath}.recorded_system_sha256.${role}`);
      if (!/^[0-9a-f]{64}$/.test(systemSha)) throw new RunnerFailure('INPUT', `${fixturePath}.recorded_system_sha256.${role} must be sha256`);
      recordedSystemSha256[role] = systemSha;
      const value = recorded[role];
      const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
      if (!values.length) throw new RunnerFailure('INPUT', `${fixturePath}.responses.${role} must contain a recorded response`);
      responses[role] = values;
    }
  }
  validateAgentRequest(request);
  return {
    schema_version: EVAL_CASE_SCHEMA,
    id,
    live_only: liveOnly,
    live_only_reason: liveOnlyReason as string | undefined,
    request,
    sources,
    responses,
    expected,
    rubric_expectations: rubricExpectations,
    recorded_system_sha256: recordedSystemSha256,
    source_disclosure_grants: sourceDisclosureGrants,
    fixture_path: fixturePath,
    raw: sourceText,
  };
}

function loadCases(pack: CapabilityPack): EvalCase[] {
  const dir = join(pack.dir, 'evals');
  if (!existsSync(dir)) throw new RunnerFailure('INPUT', `Pack has no evals directory: ${pack.id}`);
  const files = readdirSync(dir, { withFileTypes: true }).filter(x => x.isFile() && x.name.endsWith('.json')).map(x => join(dir, x.name)).sort();
  if (!files.length) throw new RunnerFailure('INPUT', `Pack has no eval fixtures: ${pack.id}`);
  const seen = new Set<string>();
  return files.map(file => {
    const raw = readFileSync(file, 'utf8');
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new RunnerFailure('INPUT', `Eval fixture is not valid JSON: ${file}`); }
    const c = validateCase(value, file, raw, pack.id);
    if (seen.has(c.id)) throw new RunnerFailure('INPUT', `Duplicate eval case: ${c.id}`);
    seen.add(c.id);
    return c;
  });
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function responseText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function workspaceFor(c: EvalCase, pack: CapabilityPack): { root: string; requestFile: string } {
  const root = mkdtempSync(join(tmpdir(), `studio-eval-${pack.id}-${c.id.toLowerCase()}-`));
  for (const source of c.sources) {
    const file = join(root, source.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source.text);
  }
  const validated = validateAgentRequest(c.request);
  const request = { ...c.request, workspace_id: validated.workspace_id, provider: 'fixture', pack_id: pack.id } as JsonObject;
  const workspace = {
    schema_version: 'studio.workspace/0.1',
    workspace_id: request.workspace_id,
    note: `Synthetic eval workspace for ${c.id}.`,
    sources: c.sources.map(source => ({ path: source.path, visibility: source.visibility })),
  };
  writeJson(join(root, 'studio-workspace.json'), workspace);
  if (c.source_disclosure_grants?.length) {
    const disclosure = request.disclosure as JsonObject;
    const sessions = new Set(c.source_disclosure_grants.map(grant => disclosure.session).filter((session): session is string => typeof session === 'string'));
    for (const session of sessions) {
      mkdirSync(join(root, 'sessions', session), { recursive: true });
      writeJson(join(root, 'sessions', session, 'session.json'), { schema_version: 'studio.session/0.1', slug: session, evidence: [] });
    }
    for (const [i, grant] of c.source_disclosure_grants.entries()) {
      const inputFile = join(root, `.eval-grant-${i}.json`);
      writeJson(inputFile, { workspace_id: request.workspace_id, session: disclosure.session, host: disclosure.host, purpose: 'drafting', ...grant });
      sourceDisclosureGrant(root, inputFile, inspectSource);
      rmSync(inputFile, { force: true });
    }
  }
  const requestFile = join(root, 'request.json');
  writeJson(requestFile, request);
  return { root, requestFile };
}

function modelFor(c: EvalCase): FixtureModel {
  const responses = c.responses!;
  return new FixtureModel((request, n) => {
    const values = responses[request.role];
    if (!values?.length) throw new Error(`No recorded response for ${request.role} in ${c.id}`);
    return responseText(values[Math.min(n - 1, values.length - 1)]);
  });
}

function staleRecordingRoles(c: EvalCase, pack: CapabilityPack): Role[] {
  return ROLES.filter(role => c.recorded_system_sha256?.[role] !== hash(systemPromptForRole(role, pack)));
}

function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function currentArtifacts(root: string, runId: string) {
  const dir = join(root, '.studio', 'artifacts', runId);
  const snapshot = readJson(join(dir, 'run-snapshot.json'));
  const currentVersion = typeof snapshot?.current_version === 'string' ? snapshot.current_version : null;
  const factual = currentVersion ? readJson(join(dir, `factual-qa-${currentVersion}.json`)) : null;
  const facts = Array.isArray(factual?.claims) ? factual.claims : [];
  const factVerdicts: Record<string, number> = {};
  for (const fact of facts) if (typeof fact?.verdict === 'string') factVerdicts[fact.verdict] = (factVerdicts[fact.verdict] ?? 0) + 1;
  const gateResults: GateResult[] = readdirSync(dir, { withFileTypes: true })
    .filter(x => x.isFile() && /^metadata-gate-v\d+\.json$/.test(x.name))
    .map(x => {
      const version = x.name.match(/^(metadata-gate-v\d+)\.json$/)![1].slice('metadata-gate-'.length);
      const gate = readJson(join(dir, x.name));
      return { version, exit_code: gate?.exit_code ?? null, result: gate?.result };
    }).sort((a, b) => a.version.localeCompare(b.version));
  return {
    currentVersion,
    blockers: Array.isArray(snapshot?.blockers) ? [...snapshot.blockers].sort() : [],
    factVerdicts,
    gateResults,
    draft: currentVersion ? readFileSync(join(dir, `draft-${currentVersion}.md`), 'utf8') : null,
  };
}

function errorDetails(error: unknown): { code: string | null; message: string; runId?: string } {
  const x = error as { code?: unknown; message?: unknown; runId?: unknown };
  return { code: typeof x?.code === 'string' ? x.code : null, message: x?.message ? String(x.message) : String(error), runId: typeof x?.runId === 'string' ? x.runId : undefined };
}

function score(c: EvalCase, actual: Omit<CaseResult, 'pass'>): CaseResult {
  if (c.live_only) return { ...actual, mode: 'live-only', pass: null, note: c.live_only_reason };
  let pass = actual.status === c.expected.status;
  if (c.expected.blockers !== undefined) pass = pass && JSON.stringify(actual.blockers) === JSON.stringify([...c.expected.blockers].sort());
  if (c.expected.fact_verdicts !== undefined) pass = pass && JSON.stringify(actual.fact_verdicts) === JSON.stringify(c.expected.fact_verdicts);
  if (c.expected.metadata_gate_exit_code !== undefined) pass = pass && actual.gate_results.at(-1)?.exit_code === c.expected.metadata_gate_exit_code;
  if (c.expected.current_version !== undefined) pass = pass && actual.current_version === c.expected.current_version;
  if (c.expected.error_contains !== undefined) pass = pass && !!actual.error?.message.includes(c.expected.error_contains);
  if (c.rubric_expectations !== undefined) pass = pass && actual.rubric_checks?.pass === true;
  return { ...actual, mode: 'replay', pass };
}

function runCase(c: EvalCase, pack: CapabilityPack): CaseResult {
  const base: Omit<CaseResult, 'pass'> = {
    id: c.id,
    mode: c.live_only ? 'live-only' : 'replay',
    status: c.live_only ? 'LIVE_ONLY' : 'ERROR',
    expected: c.expected,
    blockers: [],
    fact_verdicts: {},
    gate_results: [],
    current_version: null,
  };
  if (c.live_only) return score(c, base);
  const staleRoles = staleRecordingRoles(c, pack);
  if (staleRoles.length) return { ...base, mode: 'replay', status: 'STALE_RECORDING', pass: false, error: { code: 'STALE_RECORDING', message: `Recorded system prompt hash mismatch for ${staleRoles.join(', ')}` } };
  const ws = workspaceFor(c, pack);
  try {
    const out = startAgentRun(ws.root, ws.requestFile, { model: modelFor(c) }) as { run_id: string; status: string };
    const artifacts = currentArtifacts(ws.root, out.run_id);
    const draft = artifacts.draft;
    const rubric = c.rubric_expectations ? {
      pass: draft !== null && (c.rubric_expectations.draft_contains ?? []).every(x => draft.includes(x)) && (c.rubric_expectations.draft_not_contains ?? []).every(x => !draft.includes(x)),
      missing: draft === null ? [...(c.rubric_expectations.draft_contains ?? [])] : (c.rubric_expectations.draft_contains ?? []).filter(x => !draft.includes(x)),
      forbidden: draft === null ? [] : (c.rubric_expectations.draft_not_contains ?? []).filter(x => draft.includes(x)),
    } : undefined;
    const actual: Omit<CaseResult, 'pass'> = { ...base, status: out.status, blockers: artifacts.blockers, fact_verdicts: artifacts.factVerdicts, gate_results: artifacts.gateResults, current_version: artifacts.currentVersion, rubric_checks: rubric };
    return score(c, actual);
  } catch (error) {
    const details = errorDetails(error);
    let status = details.code ? (STATES_BY_ERROR[details.code] ?? 'ERROR') : 'ERROR';
    let artifacts = { currentVersion: null as string | null, blockers: [] as string[], factVerdicts: {} as Record<string, number>, gateResults: [] as GateResult[], draft: null as string | null };
    if (details.runId) {
      try {
        const run = inspectRun(ws.root, details.runId);
        status = run.status;
        artifacts = currentArtifacts(ws.root, details.runId);
      } catch { /* retain the provider/input error and normalized state */ }
    }
    return score(c, { ...base, status, blockers: artifacts.blockers, fact_verdicts: artifacts.factVerdicts, gate_results: artifacts.gateResults, current_version: artifacts.currentVersion, error: { code: details.code, message: details.message } });
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
}

function loadBaseline(value: string, packId: string): { report: EvalReport; source: string } {
  if (value.startsWith('-')) throw new RunnerFailure('INPUT', 'Baseline ref or result path cannot start with -');
  const file = resolve(value);
  if (existsSync(file)) {
    const report = JSON.parse(readFileSync(file, 'utf8')) as EvalReport;
    return { report, source: file };
  }
  const tempRoot = mkdtempSync(join(tmpdir(), 'studio-eval-baseline-'));
  const worktree = join(tempRoot, 'repo');
  const resultsDir = join(tempRoot, 'results');
  spawnSync('git', ['worktree', 'prune'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 20_000 });
  const added = spawnSync('git', ['worktree', 'add', '--detach', worktree, value], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 20_000 });
  if (added.status !== 0) { rmSync(tempRoot, { recursive: true, force: true }); throw new RunnerFailure('INPUT', `Baseline git ref could not be checked out: ${added.stderr || added.stdout}`); }
  try {
    const env = { ...process.env };
    delete env.STUDIO_PACKS_DIR;
    delete env.STUDIO_ALLOW_ENV_OVERRIDES;
    const cli = join(worktree, 'studio-runner', 'bin', 'studio');
    const out = spawnSync(cli, ['eval', packId, '--results-dir', resultsDir], { cwd: worktree, env, encoding: 'utf8', maxBuffer: 20_000_000 });
    const resultFile = join(resultsDir, `${packId}.json`);
    if (out.status !== 0 || !existsSync(resultFile)) throw new RunnerFailure('INPUT', `Baseline ref did not produce a replay result: ${out.error?.message || out.stderr || out.stdout || `exit ${out.status}`}. Check that ${value} has a runner with \`studio eval\`.`);
    return { report: JSON.parse(readFileSync(resultFile, 'utf8')) as EvalReport, source: `${value} (temporary git worktree)` };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 20_000 });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function diff(current: CaseResult[], baseline: { report: EvalReport; source: string }, currentFixtureExpectations: string, currentPackPin: ReturnType<typeof packPins>): BaselineDiff {
  const oldCases = new Map(baseline.report.cases.map(c => [c.id, c.pass]));
  const newCases = new Map(current.map(c => [c.id, c.pass]));
  const stale_recordings = current.filter(c => c.status === 'STALE_RECORDING').map(c => ({ id: c.id, roles: ROLES.filter(role => c.error?.message.includes(role)) }));
  const staleIds = new Set(stale_recordings.map(c => c.id));
  const regressions: BaselineDiff['regressions'] = [], improvements: BaselineDiff['improvements'] = [], unchanged: string[] = [];
  for (const [id, oldPass] of oldCases) {
    if (!newCases.has(id) || staleIds.has(id)) continue;
    const newPass = newCases.get(id)!;
    if (oldPass === true && newPass !== true) regressions.push({ id, baseline: oldPass, current: newPass });
    else if (oldPass !== true && newPass === true) improvements.push({ id, baseline: oldPass, current: newPass });
    else unchanged.push(id);
  }
  return { source: baseline.source, stale_recordings, regressions, improvements, unchanged, new_cases: [...newCases.keys()].filter(id => !oldCases.has(id)), missing_cases: [...oldCases.keys()].filter(id => !newCases.has(id)), fixture_expectations_changed: baseline.report.fixture_expectations_sha256 !== currentFixtureExpectations, pack_pin_changed: baseline.report.pack_pin.sha256 !== currentPackPin.sha256 };
}

function markdown(report: EvalReport): string {
  const lines = [`# Eval: ${report.pack_id}`, '', `Mode: fixture replay · pack ${report.pack_version} · fixture sha256 \`${report.fixture_sha256}\``, '', `Cases: ${report.totals.cases} · replayed ${report.totals.replayed} · passed ${report.totals.passed} · failed ${report.totals.failed} · live-only ${report.totals.live_only}`, ''];
  if (report.baseline_diff) {
    lines.push(`Baseline: ${report.baseline_diff.source}`, '', '## Stale recordings', '');
    if (!report.baseline_diff.stale_recordings.length) lines.push('- None.');
    else for (const item of report.baseline_diff.stale_recordings) lines.push(`- **${item.id}**: recorded system prompt mismatch for ${item.roles.join(', ') || 'unknown role'}.`);
    lines.push('');
    lines.push('## Regressions', '');
    if (!report.baseline_diff.regressions.length) lines.push('- None.');
    else for (const item of report.baseline_diff.regressions) lines.push(`- **${item.id}**: baseline passed, current result is ${item.current === null ? 'live-only' : 'failed'}.`);
    lines.push('', '## Improvements', '');
    if (!report.baseline_diff.improvements.length) lines.push('- None.');
    else for (const item of report.baseline_diff.improvements) lines.push(`- **${item.id}**: baseline did not pass, current replay passes.`);
    lines.push('');
    lines.push('## Baseline changes', '', `- Fixture expectations changed: ${report.baseline_diff.fixture_expectations_changed ? 'yes' : 'no'}.`, `- Pack pin changed: ${report.baseline_diff.pack_pin_changed ? 'yes' : 'no'}.`, '');
  }
  lines.push('## Cases', '', '| Case | Mode | Result | Status | Fact verdicts | Blockers |', '| --- | --- | --- | --- | --- | --- |');
  for (const c of report.cases) lines.push(`| ${c.id} | ${c.mode} | ${c.pass === null ? 'live-only' : c.pass ? 'PASS' : 'FAIL'} | ${c.status} | ${Object.entries(c.fact_verdicts).map(([k, v]) => `${k}:${v}`).join(', ') || '—'} | ${c.blockers.join(', ') || '—'} |`);
  lines.push('', report.pass ? 'Deterministic replay passed.' : 'Deterministic replay has failures.');
  return lines.join('\n') + '\n';
}

export function runEval(packId: string, options: { baseline?: string; live?: boolean; provider?: string; resultsDir?: string } = {}): EvalReport {
  if (options.live) {
    const provider = options.provider ?? process.env.STUDIO_EVAL_PROVIDER;
    if (!provider) throw new RunnerFailure('PROVIDER', 'Live eval is a stub; set STUDIO_EVAL_PROVIDER or pass --provider explicitly before requesting it.');
    throw new RunnerFailure('PROVIDER', `Live eval is not implemented in v0; provider "${provider}" was configured but no model was called.`);
  }
  const pack = loadPack(packId);
  const cases = loadCases(pack);
  const results = cases.map(c => runCase(c, pack));
  const failed = results.filter(c => c.pass === false).length;
  const report: EvalReport = {
    schema_version: EVAL_RESULT_SCHEMA,
    pack_id: pack.id,
    pack_version: pack.version,
    mode: 'fixture-replay',
    pack_pin: packPins(pack.id),
    fixture_sha256: hash(cases.map(c => c.raw).join('\n')),
    fixture_expectations_sha256: hash(cases.map(c => JSON.stringify({ id: c.id, expected: c.expected, rubric_expectations: c.rubric_expectations, live_only: c.live_only, live_only_reason: c.live_only_reason })).join('\n')),
    cases: results,
    totals: { cases: results.length, replayed: results.filter(c => c.pass !== null).length, passed: results.filter(c => c.pass === true).length, failed, live_only: results.filter(c => c.pass === null).length },
    pass: failed === 0,
    result_path: join(resolve(options.resultsDir ?? join(REPO_ROOT, 'evaluations', 'results')), `${pack.id}.json`),
    summary_path: join(resolve(options.resultsDir ?? join(REPO_ROOT, 'evaluations', 'results')), `${pack.id}.md`),
  };
  if (options.baseline) report.baseline_diff = diff(results, loadBaseline(options.baseline, pack.id), report.fixture_expectations_sha256, report.pack_pin);
  if (report.baseline_diff?.regressions.length) report.pass = false;
  const { result_path: _resultPath, summary_path: _summaryPath, ...persisted } = report;
  writeJson(report.result_path, persisted);
  writeFileSync(report.summary_path, markdown(report));
  return report;
}
