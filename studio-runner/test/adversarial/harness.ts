/** Shared helpers for the adversarial suite. Synthetic fixtures only; sentinel strings mark text that must not travel. */
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { REPO_ROOT } from '../../src/runner.ts';
import { startAgentRun } from '../../src/agent-run.ts';
import { FixtureModel } from '../../src/model-port.ts';
import { script } from '../helpers/fixture-script.ts';

export const FIX = join(REPO_ROOT, 'studio-runner/fixtures/agent-sample');
export const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const tmp = (p = 'adv-') => mkdtempSync(join(tmpdir(), p));
export const read = (p: string) => readFileSync(p, 'utf8');
export const jread = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
export const jwrite = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));
export const put = (ws: string, rel: string, text: string) => { const f = join(ws, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text); return f; };

export const PAD = ' This sentence pads the synthetic source so it passes the minimum-length check for evidence.';
export const hdr = (h: object) => `<!-- studio evidence\n${JSON.stringify(h, null, 2)}\n-->\n\n`;

/** Everything a model role received, system and prompt, concatenated. */
export const seen = (m: FixtureModel) => m.calls.map(c => `ROLE:${c.role}\nSYSTEM:\n${c.system}\nPROMPT:\n${c.prompt}`).join('\n=====\n');

/** All bytes under a directory (text and sqlite), as latin1 so sentinels match inside binary files too. */
export function dump(dir: string): string {
  if (!existsSync(dir)) return '';
  const out: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = lstatSync(p); if (st.isDirectory()) walk(p); else if (st.isFile()) out.push(readFileSync(p).toString('latin1')); } };
  walk(dir);
  return out.join('\n');
}
export const studioState = (ws: string) => dump(join(ws, '.studio'));

/** Copy of the synthetic agent-sample workspace (three approved sources, registry, workspace_id riverside-tool-library). */
export function agentWs() {
  const dir = tmp('adv-agent-'); cpSync(FIX, dir, { recursive: true });
  const base = jread(join(dir, 'request.json')); base.provider = 'fixture';
  return { dir, base, reqPath: join(dir, 'request.json') };
}
export function setRegistry(dir: string, edit: (sources: any[]) => any[] | void) {
  const f = join(dir, 'studio-workspace.json'); const m = jread(f); m.sources = edit(m.sources) ?? m.sources; jwrite(f, m);
}
/** Run the direct-request path with a recording fixture model. Never throws: returns {out, err}. */
export function direct(dir: string, reqEdit: (r: any) => void, model = new FixtureModel(script())) {
  const r = jread(join(dir, 'request.json')); r.provider = 'fixture'; reqEdit(r);
  const f = join(dir, `req-${Math.random().toString(36).slice(2)}.json`); jwrite(f, r);
  let out: any = null, err: Error | null = null;
  try { out = startAgentRun(dir, f, { model }); } catch (e) { err = e as Error; }
  return { out, err, model, req: f };
}
export const dbRows = (dir: string, sql: string) => { const db = new DatabaseSync(join(dir, '.studio/runs.sqlite'), { readOnly: true }); try { return db.prepare(sql).all() as any[]; } finally { db.close(); } };

/** A business workspace (studio-business.json + catalog) with separate docs root. Sentinels are baked into the docs. */
export const S = { restrictedDoc: 'ZEBRA-QUOKKA-7731-RESTRICTED-DOC', secretHeading: 'ZEBRA-QUOKKA-7731-SECRET-SECTION', redact: 'ZEBRA-QUOKKA-7731-REDACT-ME', approved: 'ZEBRA-QUOKKA-7731-APPROVED-OK' };
export function bizWs(extraCatalog: any[] = [], docs: Record<string, string> = {}, extraBiz: object = {}) {
  const top = tmp('adv-biz-'); const ws = join(top, 'workspace'), d = join(top, 'docs'), outside = join(top, 'outside');
  for (const x of [ws, d, outside, join(ws, 'context')]) mkdirSync(x, { recursive: true });
  const files: Record<string, string> = {
    'process.md': `# Process\n\n## Public\nThe committee tracked tools by hand. ${S.approved} Volunteers noted every late return in a log.\n\n## Secret plans\n${S.secretHeading} private pricing details.\n\n## After\nThe closing section says reminders helped. Mentions ${S.redact} once.\n`,
    'journal.md': `# Journal\n\n${S.restrictedDoc} is a private diary entry that must never reach a model or another workspace.\n`,
    ...docs,
  };
  for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t);
  writeFileSync(join(outside, 'secret.md'), '# Other tenant\n\nZEBRA-QUOKKA-7731-OTHER-TENANT private data.\n');
  const biz = { schema_version: 'studio.business/0.1', workspace_id: 'adv-biz', vars: { DOCS: d }, allowed_roots: ['${DOCS}'],
    defaults: { audience: 'small teams', provider: 'fixture', models: { director: 'sonnet', writer: 'sonnet', fact_reviewer: 'sonnet', craft_reviewer: 'sonnet' }, budget: { max_model_calls: 12, max_steps: 40, max_revision_rounds: 1 } },
    catalog: [
      { id: 'process', path: '${DOCS}/process.md', visibility: 'approved', description: 'process', exclude_headings: ['## Secret plans'], redact: [S.redact] },
      { id: 'journal', path: '${DOCS}/journal.md', visibility: 'restricted', description: 'private journal' },
      ...extraCatalog ],
    ...extraBiz };
  jwrite(join(ws, 'studio-business.json'), biz);
  return { top, ws, docs: d, outside, biz };
}
export const editBiz = (ws: string, f: (b: any) => void) => { const p = join(ws, 'studio-business.json'); const b = jread(p); f(b); jwrite(p, b); };
export const direction = (ws: string, over: object = {}) => { const f = join(ws, 'direction.json'); jwrite(f, { reader_question: 'Why track by hand first?', angle: 'Walk the real work before modelling it', reader_promise: 'Check one field against what really happens', audience: 'small teams', exclusions: [], approval: { type: 'owner', quote: 'Yes, go with that angle.' }, ...over }); return f; };
