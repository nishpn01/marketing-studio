/** Strict capability-pack loader. Packs are data; the text-asset Runner is shared. */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { envOverride } from './env-override.ts';
import { RunnerFailure, REPO_ROOT, hash } from './runner.ts';
import type { Role } from './model-port.ts';

export const PACK_SCHEMA = 'studio.capability-pack/0.1';
export const PACK_ROLES: Role[] = ['director', 'writer', 'fact_reviewer', 'craft_reviewer'];

type JsonSchema = {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean;
  minItems?: number;
  minLength?: number;
  pattern?: string;
};

type PackRole = { prompt: string; skills: string[]; model_tier: string };
type PackManifest = {
  schema_version: typeof PACK_SCHEMA;
  id: string;
  version: string;
  pipeline: 'text-asset';
  roles: Record<Role, PackRole>;
  output_schema: JsonSchema;
  gates: { min_draft_words: number; claim_quotes_exact: boolean; claims_require_sources: boolean };
  qa_rubric: string;
  budget_defaults: { max_model_calls: number; max_steps: number; max_revision_rounds: number };
};

export type PackPin = {
  pack_id: string;
  pack_version: string;
  manifest_sha256: string;
  roles: Record<string, { prompt_sha256: string; skills: { path: string; sha256: string }[] }>;
  qa_rubric: { path: string; sha256: string };
  sha256: string;
  git_commit: string | null;
  dirty: string[];
};

export type CapabilityPack = PackManifest & {
  dir: string;
  manifest_path: string;
  role_files: Record<Role, { prompt_path: string; skill_paths: string[] }>;
  rubric_path: string;
};

const fail = (message: string): never => { throw new RunnerFailure('INPUT', `Invalid capability pack: ${message}`); };
const SHARED_FACT_PROMPT = '../shared/fact-reviewer.md';
const SHARED_FACT_SKILLS = ['core/QUALITY-GATE-CONTRACT.md'];
const SHARED_FACT_TIER = 'review';
const object = (v: unknown, label: string): Record<string, any> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${label} must be an object`);
  return v as Record<string, any>;
};
const exactKeys = (v: Record<string, any>, keys: string[], label: string) => {
  const unknown = Object.keys(v).filter(k => !keys.includes(k));
  if (unknown.length) fail(`${label} has unknown field(s): ${unknown.join(', ')}`);
};
const slug = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(v)) fail(`${label} must be a lowercase slug`);
  return v as string;
};
const nonempty = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !v.trim()) fail(`${label} must be a non-empty string`);
  return v as string;
};
const integer = (v: unknown, label: string, lo: number, hi: number) => {
  if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) fail(`${label} must be an integer in ${lo}..${hi}`);
  return v as number;
};

function checkJsonSchema(raw: unknown, label: string): JsonSchema {
  const s = object(raw, label);
  exactKeys(s, ['type', 'required', 'properties', 'items', 'additionalProperties', 'minItems', 'minLength', 'pattern'], label);
  if (!['object', 'array', 'string', 'number', 'boolean'].includes(s.type)) fail(`${label}.type is unsupported`);
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((x: unknown) => typeof x !== 'string'))) fail(`${label}.required must be an array of strings`);
  if (s.properties !== undefined) {
    const props = object(s.properties, `${label}.properties`);
    for (const [key, child] of Object.entries(props)) checkJsonSchema(child, `${label}.properties.${key}`);
  }
  if (s.items !== undefined) checkJsonSchema(s.items, `${label}.items`);
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') fail(`${label}.additionalProperties must be boolean`);
  if (s.minItems !== undefined) integer(s.minItems, `${label}.minItems`, 0, 1000);
  if (s.minLength !== undefined) integer(s.minLength, `${label}.minLength`, 0, 1_000_000);
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== 'string') fail(`${label}.pattern must be a string`);
    try { new RegExp(s.pattern); } catch { fail(`${label}.pattern is not a valid regular expression`); }
  }
  if (s.type === 'object' && s.properties === undefined) fail(`${label}.properties is required for object schemas`);
  if (s.type === 'array' && s.items === undefined) fail(`${label}.items is required for array schemas`);
  return s as JsonSchema;
}

function packsRoot(): string {
  return resolve(envOverride('STUDIO_PACKS_DIR') || join(REPO_ROOT, 'packs'));
}
function safeFile(file: string, label: string): string {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) fail(`${label} is missing or not a regular file`);
  return file;
}
function inside(base: string, file: string): boolean {
  const b = resolve(base), f = resolve(file);
  return f === b || f.startsWith(b + sep);
}
/** Prompt paths are pack-relative; skills can be pack-relative (./...) or repo-relative for shared methods. */
function resolveEntry(packDir: string, value: string, kind: 'prompt' | 'skill' | 'rubric'): string {
  const packCandidate = resolve(packDir, value);
  const repoCandidate = resolve(REPO_ROOT, value);
  const repoScopedRubric = kind === 'rubric' && existsSync(repoCandidate);
  const repoScopedSkill = kind === 'skill' && !value.startsWith('.') && existsSync(repoCandidate);
  const file = kind === 'prompt' ? packCandidate : repoScopedRubric || repoScopedSkill ? repoCandidate : packCandidate;
  const trustedRoot = kind === 'prompt' || (kind === 'rubric' && !repoScopedRubric) ? packsRoot() : repoScopedRubric || repoScopedSkill ? REPO_ROOT : packDir;
  if (process.env.STUDIO_ALLOW_OUTSIDE_ROLE_PATHS !== '1') {
    if (!inside(trustedRoot, file)) fail(`${kind} path escapes the repository or pack: ${value}`);
  }
  const regular = safeFile(file, `${kind} ${value}`);
  if (process.env.STUDIO_ALLOW_OUTSIDE_ROLE_PATHS !== '1') {
    let trustedReal: string, fileReal: string;
    try { trustedReal = realpathSync(trustedRoot); fileReal = realpathSync(file); }
    catch { return regular; }
    if (!inside(trustedReal, fileReal)) fail(`${kind} path escapes the repository or pack: ${value}`);
  }
  return regular;
}
function displayPath(file: string): string {
  const rel = relative(REPO_ROOT, file);
  return rel && !rel.startsWith('..') ? rel : file;
}

function parsePack(packDir: string, id: string): CapabilityPack {
  if (!existsSync(packDir) || !lstatSync(packDir).isDirectory() || lstatSync(packDir).isSymbolicLink()) fail(`pack directory is missing: ${id}`);
  const manifestPath = safeFile(join(packDir, 'pack.json'), `${id}/pack.json`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { fail(`${id}/pack.json is not valid JSON`); }
  const p = object(raw, `${id}/pack.json`);
  exactKeys(p, ['schema_version', 'id', 'version', 'pipeline', 'roles', 'output_schema', 'gates', 'qa_rubric', 'budget_defaults'], `${id}/pack.json`);
  if (p.schema_version !== PACK_SCHEMA) fail(`${id}/pack.json needs schema_version ${PACK_SCHEMA}`);
  if (slug(p.id, 'id') !== id) fail(`directory ${id} does not match manifest id ${p.id}`);
  if (typeof p.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(p.version)) fail('version must be semver x.y.z');
  if (p.pipeline !== 'text-asset') fail('pipeline must be text-asset');

  const roles = object(p.roles, 'roles');
  exactKeys(roles, PACK_ROLES, 'roles');
  const roleFiles = {} as Record<Role, { prompt_path: string; skill_paths: string[] }>;
  const normalizedRoles = {} as Record<Role, PackRole>;
  for (const role of PACK_ROLES) {
    const r = object(roles[role], `roles.${role}`);
    exactKeys(r, ['prompt', 'skills', 'model_tier'], `roles.${role}`);
    const prompt = role === 'fact_reviewer' ? SHARED_FACT_PROMPT : nonempty(r.prompt, `roles.${role}.prompt`);
    const skills = role === 'fact_reviewer' ? SHARED_FACT_SKILLS : r.skills;
    const tier = role === 'fact_reviewer' ? SHARED_FACT_TIER : slug(r.model_tier, `roles.${role}.model_tier`);
    if (role === 'fact_reviewer' && (r.prompt !== SHARED_FACT_PROMPT || JSON.stringify(r.skills) !== JSON.stringify(SHARED_FACT_SKILLS) || r.model_tier !== SHARED_FACT_TIER)) fail('roles.fact_reviewer is loader-owned shared QA and cannot be overridden');
    if (!Array.isArray(skills) || skills.length < 1 || skills.some((x: unknown) => typeof x !== 'string' || !x.trim())) fail(`roles.${role}.skills must be a non-empty array of paths`);
    const promptPath = resolveEntry(packDir, prompt, 'prompt');
    const skillPaths = skills.map((x: string) => resolveEntry(packDir, x, 'skill'));
    roleFiles[role] = { prompt_path: promptPath, skill_paths: skillPaths };
    normalizedRoles[role] = { prompt, skills: [...skills], model_tier: tier };
  }

  const gates = object(p.gates, 'gates');
  exactKeys(gates, ['min_draft_words', 'claim_quotes_exact', 'claims_require_sources'], 'gates');
  const normalizedGates = {
    min_draft_words: integer(gates.min_draft_words, 'gates.min_draft_words', 1, 100_000),
    claim_quotes_exact: gates.claim_quotes_exact,
    claims_require_sources: gates.claims_require_sources,
  };
  if (typeof normalizedGates.claim_quotes_exact !== 'boolean' || typeof normalizedGates.claims_require_sources !== 'boolean') fail('gates booleans are required');
  const budget = object(p.budget_defaults, 'budget_defaults');
  exactKeys(budget, ['max_model_calls', 'max_steps', 'max_revision_rounds'], 'budget_defaults');
  const budgetDefaults = {
    max_model_calls: integer(budget.max_model_calls, 'budget_defaults.max_model_calls', 4, 24),
    max_steps: integer(budget.max_steps, 'budget_defaults.max_steps', 6, 80),
    max_revision_rounds: integer(budget.max_revision_rounds, 'budget_defaults.max_revision_rounds', 0, 2),
  };
  const outputSchema = checkJsonSchema(p.output_schema, 'output_schema');
  const rubric = nonempty(p.qa_rubric, 'qa_rubric');
  const rubricPath = resolveEntry(packDir, rubric, 'rubric');
  if (readFileSync(rubricPath, 'utf8').trim().length === 0) fail('qa rubric is empty');
  return {
    schema_version: PACK_SCHEMA, id, version: p.version, pipeline: 'text-asset', roles: normalizedRoles,
    output_schema: outputSchema, gates: normalizedGates, qa_rubric: rubric, budget_defaults: budgetDefaults,
    dir: packDir, manifest_path: manifestPath, role_files: roleFiles, rubric_path: rubricPath,
  };
}

export function loadPack(id: string): CapabilityPack {
  const packId = slug(id, 'pack id');
  return parsePack(join(packsRoot(), packId), packId);
}

export function listPackIds(): string[] {
  const root = packsRoot();
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail('packs directory is missing or unsafe');
  return readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory() && !x.name.startsWith('.') && !x.name.startsWith('_') && existsSync(join(root, x.name, 'pack.json'))).map(x => x.name).sort();
}

export function validateOutput(value: unknown, schema: JsonSchema, path = 'output'): string | null {
  if (value === null) return `${path} has the wrong type`;
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (actual !== schema.type) return `${path} has the wrong type`;
  if (schema.type === 'object') {
    const v = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in v)) return `${path}.${key} is required`;
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in v) { const error = validateOutput(v[key], child, `${path}.${key}`); if (error) return error; }
    if (schema.additionalProperties === false) for (const key of Object.keys(v)) if (!(key in (schema.properties ?? {}))) return `${path}.${key} is not allowed`;
  }
  if (schema.type === 'array') {
    const v = value as unknown[];
    if (schema.minItems !== undefined && v.length < schema.minItems) return `${path} needs at least ${schema.minItems} item(s)`;
    for (const [i, item] of v.entries()) { const error = validateOutput(item, schema.items!, `${path}[${i}]`); if (error) return error; }
  }
  if (schema.type === 'string') {
    const v = value as string;
    if (schema.minLength !== undefined && v.length < schema.minLength) return `${path} is too short`;
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) return `${path} does not match its pattern`;
  }
  return null;
}

export function packPins(packId: string, withDirty = true): PackPin {
  const pack = loadPack(packId);
  const g = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const files = [pack.manifest_path, pack.rubric_path, ...PACK_ROLES.flatMap(role => [pack.role_files[role].prompt_path, ...pack.role_files[role].skill_paths])];
  const unique = [...new Set(files)];
  const roles = Object.fromEntries(PACK_ROLES.map(role => [role, {
    prompt_sha256: hash(readFileSync(pack.role_files[role].prompt_path)),
    skills: pack.role_files[role].skill_paths.map((file, i) => ({ path: pack.roles[role].skills[i], sha256: hash(readFileSync(file)) })),
  }]));
  const manifestSha = hash(readFileSync(pack.manifest_path));
  const rubric = { path: pack.qa_rubric, sha256: hash(readFileSync(pack.rubric_path)) };
  const dirty = !withDirty ? [] : g.status !== 0 ? unique.filter(file => inside(REPO_ROOT, file)).map(file => displayPath(file)) : unique.filter(file => inside(REPO_ROOT, file) && (() => {
    const rel = displayPath(file), blob = spawnSync('git', ['cat-file', 'blob', `HEAD:${rel}`], { cwd: REPO_ROOT, maxBuffer: 20_000_000 });
    return blob.status !== 0 || !Buffer.isBuffer(blob.stdout) || !blob.stdout.equals(readFileSync(file));
  })()).map(file => displayPath(file));
  const pin = { pack_id: pack.id, pack_version: pack.version, manifest_sha256: manifestSha, roles, qa_rubric: rubric, sha256: '', git_commit: g.status === 0 ? g.stdout.trim() : null, dirty } as PackPin;
  pin.sha256 = hash(JSON.stringify({ pack_id: pack.id, pack_version: pack.version, manifest_sha256: manifestSha, roles, qa_rubric: rubric }));
  return pin;
}
