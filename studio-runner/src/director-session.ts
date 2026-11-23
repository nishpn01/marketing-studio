/**
 * Conversational Director support. The host model (Claude Code today; Codex or ChatGPT via the same commands)
 * holds the conversation with the owner. These commands give it durable, permission-aware state:
 * a business profile, relevant-context search, evidence handoff with provenance, strategy notes, an explicit
 * owner-approved direction, and a one-step hand-off to the existing Runner. Nothing here publishes.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep, relative, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RunnerFailure, hash, now, atomicWrite, openWorkspace, inspectRun, lockHeld } from './runner.ts';
import { startAgentRun, AGENT_SCHEMA, validateAgentRequest, validateSpecialist, loadSources, assertPinsClean, supersedeRun } from './agent-run.ts';
import type { AuthorityProvider } from './agent-run.ts';
import type { ModelPort } from './model-port.ts';
import { capturePassages } from './conversation-capture.ts';
import { redactAll, fold } from './redact.ts';
import { loadWorkspaceContext } from './workspace-context.ts';

type CatalogEntry = { id: string; path: string; visibility: 'approved' | 'restricted'; description: string; redact?: string[]; exclude_headings?: string[] };
export type Business = {
  schema_version: 'studio.business/0.1'; workspace_id: string; vars?: Record<string, string>; allowed_roots: string[];
  defaults: { audience: string; provider: string; models: Record<string, string>; budget: { max_model_calls: number; max_steps: number; max_revision_rounds: number } };
  catalog: CatalogEntry[]; context_sync?: { from: string; to: string }[];
};
const SLUG = /^[a-z0-9][a-z0-9-]{2,60}$/;
const SESSION = 'studio.session/0.1';

// ---------- profile ----------
function expand(p: string, vars: Record<string, string>, root: string): string {
  const out = p.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k) => { if (!(k in vars)) throw new RunnerFailure('INPUT', `Unknown variable \${${k}} in studio-business.json`); return vars[k]; });
  return resolve(root, out);
}
export function loadBusiness(root: string): Business {
  const f = join(root, 'studio-business.json');
  if (!existsSync(f) || lstatSync(f).isSymbolicLink()) throw new RunnerFailure('INPUT', 'This workspace has no studio-business.json; see templates/workspace/studio-business.example.json');
  let b: any; try { b = JSON.parse(readFileSync(f, 'utf8')); } catch { throw new RunnerFailure('INPUT', 'studio-business.json is not valid JSON'); }
  if (b?.schema_version !== 'studio.business/0.1' || typeof b.workspace_id !== 'string' || !Array.isArray(b.allowed_roots) || !Array.isArray(b.catalog) || !b.defaults) throw new RunnerFailure('INPUT', 'studio-business.json needs schema_version studio.business/0.1, workspace_id, allowed_roots, catalog and defaults');
  const ids = new Set<string>();
  for (const c of b.catalog) {
    if (!c || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(c.id) || ids.has(c.id)) throw new RunnerFailure('INPUT', `Catalog ids must be unique lowercase slugs (${c?.id})`); ids.add(c.id);
    if (c.visibility !== 'approved' && c.visibility !== 'restricted') throw new RunnerFailure('INPUT', `Catalog ${c.id} needs visibility approved|restricted`);
    if (typeof c.path !== 'string' || typeof c.description !== 'string') throw new RunnerFailure('INPUT', `Catalog ${c.id} needs path and description`);
  }
  return b as Business;
}
/** A catalog path must resolve (through symlinks) inside one of the profile's allowed roots. */
function catalogFile(root: string, b: Business, c: CatalogEntry): string {
  const vars = b.vars ?? {};
  const roots = b.allowed_roots.map(r => { try { return realpathSync(expand(r, vars, root)); } catch { return null; } }).filter((x): x is string => !!x);
  let real: string;
  try { real = realpathSync(expand(c.path, vars, root)); } catch { throw new RunnerFailure('SOURCE', `Catalog ${c.id} is not available on this machine: ${c.path}`); }
  if (!roots.some(r => real === r || real.startsWith(r + sep)) || !statSync(real).isFile()) throw new RunnerFailure('PERMISSION', `Catalog ${c.id} resolves outside allowed_roots`);
  if (statSync(real).size > 200_000) throw new RunnerFailure('INPUT', `Catalog ${c.id} exceeds 200 KB`);
  return real;
}
/** Apply the owner's privacy rules for this source: drop excluded sections, replace redacted strings. Deterministic. */
function cleaned(text: string, c: CatalogEntry): { text: string; applied: string[] } {
  const applied: string[] = [];
  let lines = text.split('\n');
  // Linear-time heading parsing (no backtracking regex). Lines are capped; keys are Unicode-folded and ignore emphasis and a trailing colon.
  const key = (t: string) => fold(t).replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().replace(/[:：]+$/, '').trim();
  const atx = (raw: string) => {
    const l = raw.length > 2000 ? raw.slice(0, 2000) : raw; let i = 0;
    while (i < l.length && i < 4 && l[i] === ' ') i++;
    if (i > 3) return null;
    let n = 0; while (l[i + n] === '#') n++;
    if (n < 1 || n > 6 || (i + n < l.length && l[i + n] !== ' ' && l[i + n] !== '\t')) return null; // CommonMark: a space or tab, not any whitespace
    let rest = l.slice(i + n).trim(), e = rest.length; while (e > 0 && rest[e - 1] === '#') e--;
    if (e < rest.length && (e === 0 || /\s/.test(rest[e - 1]))) rest = rest.slice(0, e).trim();
    return { level: n, key: key(rest), indent: i };
  };
  // Conservative scan: ambiguity must keep excluding, never end a section early. Only an unindented ATX heading outside fences, HTML comments and
  // HTML blocks ends a section. A setext heading is recognised (to START an exclusion) only over a plain paragraph. One pass; lines end \r-tolerant.
  const underline = (l: string) => { const t = l.length > 2000 ? '' : l.trim(); return t && (/^=+$/.test(t) ? 1 : /^-+$/.test(t) ? 2 : 0); };
  const blockish = (l: string) => /^(\t| {4})/.test(l) || /^\s*(>|[-*+]\s|\d+[.)]\s)/.test(l) || /^ {0,3}(`{3,}|~{3,})/.test(l) || !!atx(l);
  const scan = () => {
    const out: { at: number; span: number; level: number; key: string; kind: 'atx' | 'setext'; indent: number }[] = [];
    let fence: string | null = null, comment = false, html = false, par = false; // par: the current paragraph contains a block-ish line
    lines.forEach((raw, i) => {
      const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const f = /^ {0,3}(`{3,}|~{3,})([^]*)$/.exec(l);
      if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null; par = false; return; } // a closer has no info string
      if (comment) { if (l.includes('-->')) comment = false; return; }
      if (!l.trim()) { html = false; par = false; return; }
      if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = f[1]; par = false; return; }
      if (/^ {0,3}<!--/.test(l) && l.indexOf('-->', l.indexOf('<!--')) < 0) { comment = true; par = false; return; }
      if (/^ {0,3}<\/?[A-Za-z]/.test(l)) html = true; // raw HTML block until the next blank line
      const h = html ? null : atx(l); if (h) { par = true; out.push({ at: i, span: 1, kind: 'atx', ...h }); return; }
      par = par || blockish(l);
      const raw1 = lines[i + 1] ?? ''; const u = underline(raw1.endsWith('\r') ? raw1.slice(0, -1) : raw1);
      if (!u || l.length > 2000 || underline(l) || par || html) return;
      out.push({ at: i, span: 2, level: u, key: key(l), kind: 'setext', indent: 0 });
    });
    return out;
  };
  const heads = scan(); const cuts: { from: number; to: number; level: number }[] = []; const wanted: string[] = [];
  for (const h of c.exclude_headings ?? []) {
    const hs = h.trim(), want = atx(hs) ?? (hs && !hs.startsWith('#') ? { level: 0, key: key(hs) } : null);
    if (!want || !want.key) throw new RunnerFailure('INPUT', `Catalog ${c.id} has an invalid exclude_headings entry`);
    const hits = heads.filter(x => (want.level === 0 || x.level === want.level) && x.key === want.key);
    // Fail closed: an exclusion that matches nothing means the document no longer matches the owner's privacy profile.
    if (!hits.length) throw new RunnerFailure('PERMISSION', `Catalog ${c.id}: an exclude_headings entry matched no section, so the document is withheld; fix the profile or the document`);
    wanted.push(want.key);
    for (const x of hits) cuts.push({ from: x.at, to: heads.find(y => y.kind === 'atx' && y.indent === 0 && y.at >= x.at + x.span && y.level <= x.level)?.at ?? lines.length, level: x.level });
  }
  if (cuts.length) {
    const keep: string[] = []; let i = 0;
    for (const cut of cuts.sort((p, q) => p.from - q.from || q.to - p.to)) {
      if (cut.from < i) { if (cut.to > i) i = cut.to; continue; } // inside (or extending) an earlier cut
      keep.push(...lines.slice(i, cut.from), `${'#'.repeat(cut.level)} [section omitted for privacy]`); i = cut.to; applied.push('excluded section');
    }
    lines = [...keep, ...lines.slice(i)];
    // Post-check: any surviving line that still reads as an excluded heading (hidden in a comment, quote, list, odd fence...) means the parser disagreed with the
    // reader about structure, so withhold the document rather than risk the tail of a private section.
    for (const l of lines) {
      if (l.length > 2000 || !l.trim()) continue;
      const k = key(l.replace(/^[\s>]*(?:(?:[-*+]|\d+[.)])\s+)*/, '').replace(/^#{1,6}(?=[ \t]|$)/, '').replace(/[ \t]+#+\s*$/, ''));
      if (k && wanted.includes(k)) throw new RunnerFailure('PERMISSION', `Catalog ${c.id}: an excluded heading is still present after exclusion, so the document is withheld`);
    }
  }
  const r = redactAll(lines.join('\n'), c.redact ?? [], '[omitted for privacy]');
  for (const x of c.redact ?? []) if (redactAll(lines.join('\n'), [x], '').count) applied.push('redacted configured value');
  return { text: r.text, applied };
}
function gitPin(file: string): { repo_commit: string | null; dirty: boolean | null } {
  const d = dirname(file);
  const c = spawnSync('git', ['-C', d, 'log', '-1', '--format=%H', '--', basename(file)], { encoding: 'utf8' });
  if (c.status !== 0 || !c.stdout.trim()) return { repo_commit: null, dirty: null };
  const s = spawnSync('git', ['-C', d, 'status', '--porcelain', '--', basename(file)], { encoding: 'utf8' });
  return { repo_commit: c.stdout.trim(), dirty: s.status === 0 ? s.stdout.trim().length > 0 : null };
}

// ---------- context sync ----------
/** Copy owner-maintained guidance (style guide, campaign decisions) into context/ with a provenance header. */
export function contextSync(workspaceArg: string) {
  const root = realpathSync(resolve(workspaceArg)); const b = loadBusiness(root);
  const out = [];
  for (const s of b.context_sync ?? []) {
    if (!s.to.startsWith('context/') || s.to.includes('..')) throw new RunnerFailure('PERMISSION', `context_sync target must be inside context/: ${s.to}`);
    const src = catalogFile(root, b, { id: 'sync', path: s.from, visibility: 'approved', description: '' });
    const entries = b.catalog.filter(c => { try { return catalogFile(root, b, c) === src; } catch { return false; } });
    if (entries.length !== 1 || entries[0].visibility !== 'approved') throw new RunnerFailure('PERMISSION', 'Context sync requires one explicitly approved catalog source');
    const original = readFileSync(src, 'utf8'); const body = cleaned(original, entries[0]).text; const pin = gitPin(src);
    atomicWrite(join(root, s.to), `<!-- Synced from ${s.from} (sha256 ${hash(original)}, commit ${pin.repo_commit ?? 'n/a'}${pin.dirty ? ', uncommitted changes' : ''}) at ${now()}. Edit the original, not this copy. -->\n\n${body}`);
    out.push({ to: s.to, from: s.from, sha256: hash(body), repo_commit: pin.repo_commit });
  }
  return { synced: out };
}

// ---------- relevant-context search ----------
const STOP = new Set('a an and are as at be but by for from has have how i if in into is it its of on or that the this to was were what when where which who why will with you your our we my me do does did not no can'.split(' '));
const terms = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g)?.filter(w => !STOP.has(w)) ?? [];
/** Section-level keyword retrieval over the catalog (after privacy cleaning) and context files. Returns passages, not whole files. */
export function contextSearch(workspaceArg: string, query: string, limit = 8) {
  const root = realpathSync(resolve(workspaceArg)); const b = loadBusiness(root);
  const q = [...new Set(terms(query))];
  if (!q.length) throw new RunnerFailure('INPUT', 'Query needs at least one meaningful word');
  const docs: { id: string; path: string; visibility: string; text: string }[] = [];
  for (const c of b.catalog) {
    if (c.visibility === 'restricted') continue;
    try { docs.push({ id: c.id, path: c.path, visibility: c.visibility, text: cleaned(readFileSync(catalogFile(root, b, c), 'utf8'), c).text }); }
    catch (e) { docs.push({ id: c.id, path: c.path, visibility: c.visibility, text: '' }); void e; }
  }
  for (const f of loadWorkspaceContext(root).files.filter(f => f.roles.includes('director'))) docs.push({ id: `context:${basename(f.path)}`, path: f.path, visibility: 'guidance (not evidence)', text: f.text });
  const hits: any[] = [];
  // Captured conversations: one passage per record item or message, so a search never loads a whole conversation.
  const cap = capturePassages(root);
  for (const p of cap.passages) {
    const words = terms(p.text), hw = terms(p.heading);
    const score = q.reduce((s, t) => s + Math.min(words.filter(w => w.startsWith(t)).length, 5) + 2 * hw.filter(w => w.startsWith(t)).length, 0) + (p.id.includes('#ci-') ? 1 : 0);
    if (score > 1) hits.push({ catalog_id: p.id, path: p.path, visibility: p.visibility, heading: p.heading, lines: '-', score, snippet: p.text.replace(/\s+/g, ' ').slice(0, 500) });
  }
  for (const d of docs) {
    const lines = d.text.split('\n'); let start = 0;
    const flush = (end: number) => {
      const body = lines.slice(start, end).join('\n'); const heading = lines[start]?.startsWith('#') ? lines[start].replace(/^#+\s*/, '') : '(top)';
      const words = terms(body), hw = terms(heading);
      const score = q.reduce((s, t) => s + Math.min(words.filter(w => w.startsWith(t)).length, 5) + 3 * hw.filter(w => w.startsWith(t)).length, 0);
      if (score > 0) hits.push({ catalog_id: d.id, path: d.path, visibility: d.visibility, heading, lines: `${start + 1}-${end}`, score, snippet: body.replace(/\s+/g, ' ').slice(0, 500) });
    };
    lines.forEach((l, i) => { if (i > start && /^#{1,4}\s/.test(l)) { flush(i); start = i; } });
    flush(lines.length);
  }
  return { query, results: hits.sort((x, y) => y.score - x.score).slice(0, Math.max(1, Math.min(limit, 20))), ...(cap.warnings.length ? { capture_warnings: cap.warnings } : {}) };
}

// ---------- sessions ----------
export type Session = { schema_version: typeof SESSION; slug: string; idea: string; created_at: string; state: string; evidence: any[]; notes: any[]; direction: any | null; run_id: string | null; previous_runs?: string[]; previous_directions?: any[]; improvements?: { id: string; scope: string; status: string }[]; history: { at: string; event: string; detail?: string }[] };
const sdir = (root: string, slug: string) => { if (!SLUG.test(slug)) throw new RunnerFailure('INPUT', 'Session slug must be 3-61 lowercase letters, digits or hyphens'); return join(root, 'sessions', slug); };
export function loadSession(root: string, slug: string): Session {
  const f = join(sdir(root, slug), 'session.json');
  if (!existsSync(f)) throw new RunnerFailure('NOT_FOUND', `No session ${slug}`);
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { throw new RunnerFailure('SOURCE', `Session record ${slug} is not valid JSON`); }
}
export function saveSession(root: string, s: Session, event: string, detail?: string) {
  s.history.push({ at: now(), event, ...(detail ? { detail } : {}) });
  atomicWrite(join(sdir(root, s.slug), 'session.json'), JSON.stringify(s, null, 2));
}
function ensureWorkspace(root: string, b: Business) {
  const ws = join(root, 'studio-workspace.json');
  if (!existsSync(ws)) atomicWrite(ws, JSON.stringify({ schema_version: 'studio.workspace/0.1', workspace_id: b.workspace_id }, null, 2));
  const id = JSON.parse(readFileSync(ws, 'utf8')).workspace_id;
  if (id !== b.workspace_id) throw new RunnerFailure('PERMISSION', 'studio-business.json workspace_id differs from studio-workspace.json');
}
export function sessionStart(workspaceArg: string, idea: string, slug?: string) {
  const root = realpathSync(resolve(workspaceArg)); const b = loadBusiness(root); ensureWorkspace(root, b);
  if (typeof idea !== 'string' || idea.trim().length < 10) throw new RunnerFailure('INPUT', 'Describe the idea in at least 10 characters');
  const s = slug ?? (`${new Date().toISOString().slice(0, 10)}-` + terms(idea).slice(0, 5).join('-')).slice(0, 60).replace(/-+$/, '');
  if (existsSync(join(sdir(root, s), 'session.json'))) throw new RunnerFailure('INPUT', `Session ${s} already exists`);
  const session: Session = { schema_version: SESSION, slug: s, idea: idea.trim(), created_at: now(), state: 'discussing', evidence: [], notes: [], direction: null, run_id: null, history: [] };
  saveSession(root, session, 'started');
  return { session: s, state: session.state, next: 'Discuss the idea with the owner; use context-search; add evidence; save a strategy note; get explicit approval of a direction.' };
}
function addEvidenceFile(root: string, s: Session, name: string, header: Record<string, unknown>, body: string) {
  if (s.state !== 'discussing') throw new RunnerFailure('INPUT', `Evidence can only be added while discussing (session is ${s.state})`);
  const rel = `sources/${s.slug}/${name}`;
  if (existsSync(join(root, rel))) throw new RunnerFailure('INPUT', `Evidence ${rel} already exists`);
  const content = `<!-- studio evidence\n${JSON.stringify(header, null, 2)}\n-->\n\n${body}`;
  atomicWrite(join(root, rel), content);
  const rec = { path: rel, sha256: hash(content), ...header };
  s.evidence.push(rec); return rec;
}
/** Evidence from the business's own catalog (local files the profile authorizes), optionally one section, with privacy rules applied. */
export function evidenceAddCatalog(workspaceArg: string, slug: string, catalogId: string, section?: string) {
  const root = realpathSync(resolve(workspaceArg)); const b = loadBusiness(root); const s = loadSession(root, slug);
  const c = b.catalog.find(x => x.id === catalogId); if (!c) throw new RunnerFailure('INPUT', `No catalog entry ${catalogId}`);
  const file = catalogFile(root, b, c); const original = readFileSync(file, 'utf8');
  let { text, applied } = cleaned(original, c);
  if (section) {
    const lines = text.split('\n'); const i = lines.findIndex(l => /^#+\s/.test(l) && l.replace(/^#+\s*/, '').trim().toLowerCase() === section.trim().toLowerCase());
    if (i < 0) throw new RunnerFailure('INPUT', `Section "${section}" not found in ${catalogId}`);
    const level = /^#+/.exec(lines[i])![0].length; let j = i + 1;
    while (j < lines.length && !(/^#+\s/.test(lines[j]) && /^#+/.exec(lines[j])![0].length <= level)) j++;
    text = lines.slice(i, j).join('\n');
  }
  const pin = gitPin(file);
  const name = `${catalogId}${section ? '-' + terms(section).join('-').slice(0, 30) : ''}.md`;
  const rec = addEvidenceFile(root, s, name, { kind: 'catalog', catalog_id: c.id, origin: c.path, section: section ?? null, cleaned_sha256: hash(text), repo_commit: pin.repo_commit, uncommitted_changes: pin.dirty, visibility: c.visibility, privacy_rules_applied: applied, retrieved_by: 'studio context catalog', retrieved_at: now() }, text);
  saveSession(root, s, 'evidence_added', rec.path);
  return rec;
}
/** Evidence a host retrieved with its own authorized tools (web, GitHub, Google Drive...). The Runner never reuses that host's credentials. */
export function evidenceAddHost(workspaceArg: string, slug: string, o: { kind: string; uri: string; file: string; retrieved_by: string; revision?: string; title?: string; visibility?: string; retrieved_at?: string; owner_quote?: string }) {
  const root = realpathSync(resolve(workspaceArg)); loadBusiness(root); const s = loadSession(root, slug);
  if (!['web', 'github', 'gdrive', 'other'].includes(o.kind)) throw new RunnerFailure('INPUT', 'kind must be web, github, gdrive or other');
  if (!/^(https?:\/\/|gdrive:|github:)/.test(o.uri)) throw new RunnerFailure('INPUT', 'uri must be http(s), gdrive: or github:');
  if (!/^[a-z0-9-]+:[A-Za-z0-9_.-]+$/.test(o.retrieved_by)) throw new RunnerFailure('INPUT', 'retrieved_by must look like host:tool, e.g. claude-code:WebFetch');
  if ((o.kind === 'github' || o.kind === 'gdrive') && !o.revision) throw new RunnerFailure('INPUT', `${o.kind} evidence needs --revision (commit SHA or Drive revision id)`);
  const vis = o.visibility ?? (o.kind === 'web' ? 'approved' : 'restricted');
  if (vis !== 'approved' && vis !== 'restricted') throw new RunnerFailure('INPUT', 'visibility must be approved or restricted');
  // A host may not launder connector content into 'approved' on its own say-so; the owner's words are recorded (unauthenticated).
  if (vis === 'approved' && o.kind !== 'web' && (typeof o.owner_quote !== 'string' || o.owner_quote.trim().length < 10)) throw new RunnerFailure('PERMISSION', `${o.kind} evidence can only be approved with the owner's own words (--owner-quote)`);
  const f = resolve(o.file); if (lstatSync(f).isSymbolicLink()) throw new RunnerFailure('PERMISSION', 'Evidence file is a symlink');
  const body = readFileSync(f, 'utf8'); if (body.trim().length < 50 || body.length > 150_000) throw new RunnerFailure('INPUT', 'Evidence text must be 50..150000 characters (the original passage, not a summary)');
  const n = s.evidence.filter(e => e.kind === o.kind).length + 1;
  const rec = addEvidenceFile(root, s, `${o.kind}-${n}.md`, { kind: o.kind, uri: o.uri, title: o.title ?? null, revision: o.revision ?? null, retrieved_by: o.retrieved_by, retrieved_at: o.retrieved_at ?? now(), visibility: vis, credential_note: 'Retrieved with the host\'s own authorization; no credentials are stored or shared with other hosts.' }, body);
  saveSession(root, s, 'evidence_added', rec.path);
  if (vis === 'approved' && o.kind !== 'web') saveSession(root, s, 'visibility_approved_by_owner (unauthenticated)', `${rec.path}: ${o.owner_quote!.trim()}`);
  return rec;
}
/** Drop a source while still discussing (the owner or Director decides it isn't needed or is too sensitive). */
export function evidenceRemove(workspaceArg: string, slug: string, path: string) {
  const root = realpathSync(resolve(workspaceArg)); loadBusiness(root); const s = loadSession(root, slug);
  if (s.state !== 'discussing') throw new RunnerFailure('INPUT', `Evidence can only be removed while discussing (session is ${s.state})`);
  const i = s.evidence.findIndex(e => e.path === path); if (i < 0) throw new RunnerFailure('INPUT', `No evidence ${path} in session ${slug}`);
  rmSync(join(root, path), { force: true }); s.evidence.splice(i, 1); saveSession(root, s, 'evidence_removed', path);
  return { session: slug, removed: path, remaining: s.evidence.map(e => e.path) };
}
/** Persist the Director's strategy work (content strategy, campaign plan, creative brief) so it survives the chat. */
export function sessionNote(workspaceArg: string, slug: string, kind: string, file: string) {
  const root = realpathSync(resolve(workspaceArg)); loadBusiness(root); const s = loadSession(root, slug);
  if (!['strategy', 'campaign_plan', 'creative_brief', 'decision', 'research_summary'].includes(kind)) throw new RunnerFailure('INPUT', 'kind must be strategy, campaign_plan, creative_brief, decision or research_summary');
  const body = readFileSync(resolve(file), 'utf8'); if (body.trim().length < 20) throw new RunnerFailure('INPUT', 'Note is empty');
  const name = `notes/${String(s.notes.length + 1).padStart(2, '0')}-${kind}.md`;
  atomicWrite(join(sdir(root, slug), name), body);
  s.notes.push({ kind, path: `sessions/${slug}/${name}`, sha256: hash(body), at: now() }); saveSession(root, s, 'note_added', kind);
  return { session: slug, note: `sessions/${slug}/${name}` };
}
/**
 * Record the owner's approval of a direction. Requires the owner's own words. A 'test-authorization' is allowed for
 * evaluations and is labelled as such everywhere; it is not owner approval of the direction.
 */
export function directionApprove(workspaceArg: string, slug: string, file: string) {
  const root = realpathSync(resolve(workspaceArg)); loadBusiness(root); const s = loadSession(root, slug);
  const reopen = ['in_review', 'run_failed', 'needs_evidence'].includes(s.state);
  if (s.state !== 'discussing' && !reopen) throw new RunnerFailure('INPUT', `Direction can only be approved while discussing, or to replace the direction of a session that has run (session is ${s.state})`);
  if (!s.evidence.length) throw new RunnerFailure('INPUT', 'Add at least one evidence source before approving a direction');
  let d: any; try { d = JSON.parse(readFileSync(resolve(file), 'utf8')); } catch { throw new RunnerFailure('INPUT', 'Direction file is not valid JSON'); }
  for (const k of ['reader_question', 'angle', 'reader_promise', 'audience']) if (typeof d?.[k] !== 'string' || d[k].trim().length < 5) throw new RunnerFailure('INPUT', `Direction needs ${k}`);
  if (!Array.isArray(d.exclusions)) throw new RunnerFailure('INPUT', 'Direction needs exclusions[] (may be empty)');
  if (d.pack_id !== undefined && d.specialist !== undefined && d.pack_id !== d.specialist) throw new RunnerFailure('INPUT', 'pack_id and legacy specialist must identify the same capability pack');
  const packId = d.pack_id ?? d.specialist;
  if (packId !== undefined) validateSpecialist(packId);
  const a = d.approval;
  if (!a || !['owner', 'test-authorization'].includes(a.type) || typeof a.quote !== 'string' || a.quote.trim().length < 3) throw new RunnerFailure('INPUT', 'Direction needs approval {type: owner|test-authorization, quote: the approver\'s own words}');
  const direction = { reader_question: d.reader_question, angle: d.angle, reader_promise: d.reader_promise, audience: d.audience, exclusions: d.exclusions, notes: typeof d.notes === 'string' ? d.notes : '', ...(packId ? { pack_id: packId, specialist: packId } : {}), approval: { type: a.type, quote: a.quote, recorded_at: now(), authenticated: false } };
  if (reopen) { s.previous_directions = [...(s.previous_directions ?? []), s.direction]; if (s.run_id) { s.previous_runs = [...(s.previous_runs ?? []), s.run_id]; supersede(root, s.run_id, 'a new direction was approved'); } s.run_id = null; }
  s.direction = direction; s.state = 'direction_approved';
  atomicWrite(join(sdir(root, slug), 'direction.json'), JSON.stringify(direction, null, 2));
  saveSession(root, s, 'direction_approved', a.type);
  return { session: slug, state: s.state, approval: direction.approval };
}
/** Build the Runner request from the profile and session (no hand-written request.json) and start the existing pipeline. */
/** A session left 'running' by a crash, with no live Runner, is recovered: linked run -> run_failed (resume by id or rerun), no run -> ready to run again. */
/** Best effort: the earlier run may not exist in this workspace's store. */
function supersede(root: string, runId: string, reason: string, alreadyLocked = false) { try { supersedeRun(root, runId, reason, alreadyLocked); } catch (e) { if (!(e instanceof RunnerFailure && e.code === 'NOT_FOUND')) throw e; } }
function recoverStale(root: string, s: Session) {
  if (s.state !== 'running') return;
  if (lockHeld(root)) throw new RunnerFailure('LOCKED', 'This session is running in another process');
  s.state = s.run_id ? 'run_failed' : 'direction_approved'; saveSession(root, s, 'recovered_stale_running', s.run_id ?? 'no run was created');
}
export function sessionRun(workspaceArg: string, slug: string, opts: { model?: ModelPort; host?: string; allowDirtyPins?: boolean; authority?: AuthorityProvider; supersedes?: string; supersedeReason?: string } = {}) {
  const root = realpathSync(resolve(workspaceArg)); const b = loadBusiness(root); ensureWorkspace(root, b); const s = loadSession(root, slug); recoverStale(root, s);
  if (s.state !== 'direction_approved' || !s.direction) throw new RunnerFailure('INPUT', `Run needs an approved direction (session is ${s.state})`);
  for (const e of s.evidence) if (!existsSync(join(root, e.path)) || hash(readFileSync(join(root, e.path))) !== e.sha256) throw new RunnerFailure('SOURCE', `Evidence changed or missing: ${e.path}`);
  const req = { schema_version: AGENT_SCHEMA, workspace_id: b.workspace_id, mode: 'one_off', idea: s.idea, audience: s.direction.audience,
    ...(s.direction.pack_id ? { pack_id: s.direction.pack_id, specialist: s.direction.pack_id } : s.direction.specialist ? { specialist: s.direction.specialist } : {}),
    source_paths: s.evidence.map(e => e.path), restricted_sources: s.evidence.filter(e => e.visibility === 'restricted').map(e => e.path),
    ...(opts.host ? { disclosure: { session: slug, host: opts.host } } : {}),
    ...(opts.authority ? { authority_session: slug } : {}),
    provider: opts.model?.provider ?? b.defaults.provider, models: b.defaults.models, budget: b.defaults.budget,
    permissions: { actions: ['read_sources', 'write_private_draft', 'run_metadata_gate'] },
    approved_direction: { reader_question: s.direction.reader_question, angle: s.direction.angle, reader_promise: s.direction.reader_promise, exclusions: s.direction.exclusions, notes: s.direction.notes, approval_type: s.direction.approval.type, approval_quote: s.direction.approval.quote } };
  loadSources(root, validateAgentRequest(req), { authority: opts.authority });
  const reqPath = join(sdir(root, slug), 'request.json'); atomicWrite(reqPath, JSON.stringify(req, null, 2));
  assertPinsClean(s.direction.pack_id ?? s.direction.specialist, opts.allowDirtyPins);
  s.state = 'running'; saveSession(root, s, 'run_started');
  let out: any;
  try { out = startAgentRun(root, reqPath, { model: opts.model, allowDirtyPins: opts.allowDirtyPins, authority: opts.authority, onRun: id => { if (opts.supersedes) { s.previous_runs = [...(s.previous_runs ?? []), opts.supersedes]; supersede(root, opts.supersedes, opts.supersedeReason ?? 'rerun', true); } s.run_id = id; saveSession(root, s, 'run_linked', id); } }); }
  catch (e) {
    if (e instanceof RunnerFailure && e.code === 'LOCKED') { s.run_id = null; s.state = 'direction_approved'; saveSession(root, s, 'run_not_started', 'workspace busy'); throw e; } // another process owns the workspace; do not mislabel
    s.run_id = e instanceof RunnerFailure && 'runId' in e && typeof e.runId === 'string' ? e.runId : null; s.state = 'run_failed'; saveSession(root, s, 'run_failed', e instanceof Error ? e.message : String(e)); throw e; }
  s.run_id = out.run_id; s.state = out.status === 'WAITING_FOR_OWNER' ? 'in_review' : out.status === 'BLOCKED_EVIDENCE' ? 'needs_evidence' : 'run_failed';
  saveSession(root, s, 'run_finished', out.status);
  return { session: slug, ...out, package: relative(root, join(out.artifact_dir, 'review-package.md')) };
}
/**
 * Continue the same newsletter in a fresh run: same approved direction, same evidence, earlier runs kept.
 * Used after an improvement changed pinned skills, role prompts or workspace context, which blocks revising the old run.
 */
export function sessionRerun(workspaceArg: string, slug: string, reason: string, opts: { model?: ModelPort; host?: string; allowDirtyPins?: boolean; authority?: AuthorityProvider } = {}) {
  const root = realpathSync(resolve(workspaceArg)); loadBusiness(root); const s = loadSession(root, slug); recoverStale(root, s);
  if (!['in_review', 'run_failed', 'needs_evidence'].includes(s.state) || !s.direction) throw new RunnerFailure('INPUT', `Rerun needs a session with an approved direction that has already run (session is ${s.state})`);
  if (typeof reason !== 'string' || reason.trim().length < 10) throw new RunnerFailure('INPUT', 'Say why the newsletter is being re-run (at least 10 characters)');
  for (const e of s.evidence) if (!existsSync(join(root, e.path)) || hash(readFileSync(join(root, e.path))) !== e.sha256) throw new RunnerFailure('SOURCE', `Evidence changed or missing: ${e.path}`);
  loadSources(root, { source_paths: s.evidence.map(e => e.path), restricted_sources: s.evidence.filter(e => e.visibility === 'restricted').map(e => e.path), ...(opts.host ? { disclosure: { session: slug, host: opts.host } } : {}) }, { authority: opts.authority });
  assertPinsClean(s.direction.pack_id ?? s.direction.specialist, opts.allowDirtyPins); // refuse before touching the earlier run
  // The earlier run is superseded only once the replacement run row exists; any refusal before that restores the session.
  const old = s.run_id, prevState = s.state;
  s.run_id = null; s.state = 'direction_approved'; saveSession(root, s, 'rerun_requested', reason.trim());
  try { return sessionRun(root, slug, { ...opts, supersedes: old ?? undefined, supersedeReason: `rerun: ${reason.trim()}` }); }
  catch (e) {
    const t = loadSession(root, slug);
    if (!t.run_id) { t.run_id = old; t.state = prevState; saveSession(root, t, 'rerun_not_started', 'earlier run kept'); }
    throw e;
  }
}
/** One-line-per-session overview for the host to read back to the owner. */
export function sessionStatus(workspaceArg: string, slug?: string) {
  const root = realpathSync(resolve(workspaceArg)); loadBusiness(root);
  const slugs = slug ? [slug] : existsSync(join(root, 'sessions')) ? readdirSync(join(root, 'sessions')).filter(x => SLUG.test(x) && existsSync(join(root, 'sessions', x, 'session.json'))) : [];
  return slugs.map(x => {
    const s = loadSession(root, x);
    let run: any = null;
    if (s.run_id) {
      const r = inspectRun(root, s.run_id); const snapP = join(root, '.studio', 'artifacts', s.run_id, 'run-snapshot.json');
      const snap = existsSync(snapP) ? JSON.parse(readFileSync(snapP, 'utf8')) : null;
      run = { run_id: s.run_id, status: r.status, version: snap?.current_version ?? null, digest: snap?.current_digest ?? null, blockers: snap?.blockers ?? [], package: `.studio/artifacts/${s.run_id}/review-package.md` };
    }
    return { session: x, state: s.state, idea: s.idea, evidence: s.evidence.map(e => `${e.path} (${e.visibility})`), notes: s.notes.map(n => n.path), direction: s.direction ? { angle: s.direction.angle, approval: s.direction.approval.type, ...(s.direction.specialist ? { specialist: s.direction.specialist } : {}) } : null, run };
  });
}
