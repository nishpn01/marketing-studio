import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, symlinkSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextSearch, contextSync, sessionStart, evidenceAddCatalog, evidenceAddHost, evidenceRemove, sessionNote, directionApprove, sessionRun, sessionStatus } from '../src/director-session.ts';
import { validateAgentRequest, approveAgentRun, startAgentRun } from '../src/agent-run.ts';
import { FixtureModel } from '../src/model-port.ts';
import { script, brief, draft, facts } from './helpers/fixture-script.ts';
import { sourceDisclosureGrant } from '../src/source-disclosure.ts';
import { inspectSource } from '../src/agent-run.ts';
import { realpathSync } from 'node:fs';

const DOC = `# Process notes

## Tracker status
The status column mixed stage, outcome and posting state in one cell, for example "Rejected, Job Closed". A rejection can happen at any stage.

## Credentials
Passwords were found in a notes column. SECRET-ROW-TEXT

## Reminders
Volunteers texted borrowers by hand before the reminder test. Six tools came back late this week. PRIVATE-REDACTION-SENTINEL-5389
`;
function biz() {
  const top = mkdtempSync(join(tmpdir(), 'biz-'));
  const ws = join(top, 'workspace'), docs = join(top, 'docs'), outside = join(top, 'outside');
  for (const d of [ws, docs, outside, join(ws, 'context')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(docs, 'process.md'), DOC);
  writeFileSync(join(docs, 'journal.md'), '# Journal\n\nI walked the process against how I really work and corrected three steps. Rejected is not a stage.\n');
  writeFileSync(join(docs, 'style.md'), '# Style\n\nFirst person. Few dates.\n');
  writeFileSync(join(outside, 'secret.md'), '# Other tenant\n\nPrivate data that must never be read by this workspace.\n');
  writeFileSync(join(ws, 'context', 'voice.md'), 'Voice guidance: plain words about tracker status.');
  writeFileSync(join(ws, 'context', 'writer.md'), 'WRITER-ONLY-SENTINEL tracker voice.');
  writeFileSync(join(ws, 'studio-context.json'), JSON.stringify({ schema_version: 'studio.context/0.1', files: [
    { path: 'context/voice.md', roles: ['director'], purpose: 'voice guidance' },
    { path: 'context/writer.md', roles: ['writer'], purpose: 'writer guidance' },
  ] }));
  writeFileSync(join(ws, 'studio-business.json'), JSON.stringify({
    schema_version: 'studio.business/0.1', workspace_id: 'test-biz', vars: { DOCS: docs }, allowed_roots: ['${DOCS}'],
    defaults: { audience: 'small teams', provider: 'claude-code-cli', models: { director: 'sonnet', writer: 'sonnet', fact_reviewer: 'sonnet', craft_reviewer: 'sonnet' }, budget: { max_model_calls: 12, max_steps: 40, max_revision_rounds: 1 } },
    catalog: [
      { id: 'process', path: '${DOCS}/process.md', visibility: 'approved', description: 'process analysis', exclude_headings: ['## Credentials'], redact: ['Six tools came back late this week.', 'PRIVATE-REDACTION-SENTINEL-5389'] },
      { id: 'style', path: '${DOCS}/style.md', visibility: 'approved', description: 'style guidance' },
      { id: 'journal', path: '${DOCS}/journal.md', visibility: 'restricted', description: 'private journal' },
      { id: 'escape', path: '${DOCS}/../outside/secret.md', visibility: 'approved', description: 'should be refused' },
    ],
    context_sync: [{ from: '${DOCS}/style.md', to: 'context/style.md' }],
  }));
  return { ws, docs, top };
}
function direction(ws: string, over: object = {}) {
  const f = join(ws, 'direction.json');
  writeFileSync(f, JSON.stringify({ reader_question: 'Why can a status field stop you learning?', angle: 'Walk the real work before modelling it', reader_promise: 'Check one field you track against what really happens', audience: 'small teams building tools', exclusions: ['No personal job-search figures'], approval: { type: 'owner', quote: 'Yes, go with the status-field angle.' }, ...over }));
  return f;
}

test('session lifecycle: start -> discussing; slugs are safe; duplicates are refused', () => {
  const { ws } = biz();
  const s = sessionStart(ws, 'A newsletter about why our tracker status field was wrong', 'tracker-status');
  assert.equal(s.state, 'discussing');
  assert.throws(() => sessionStart(ws, 'again, same slug please', 'tracker-status'), /already exists/);
  assert.throws(() => sessionStart(ws, 'bad slug attempt here', '../escape'), /slug/);
  assert.equal(JSON.parse(readFileSync(join(ws, 'studio-workspace.json'), 'utf8')).workspace_id, 'test-biz');
});

test('session and context writes refuse symlinked directories outside the workspace', () => {
  const a = biz();
  symlinkSync(join(a.top, 'outside'), join(a.ws, 'sessions'));
  assert.throws(() => sessionStart(a.ws, 'A synthetic session for isolation', 'safe-test'), /symbolic link/);
  assert.equal(existsSync(join(a.top, 'outside', 'safe-test')), false);
  const b = biz(); rmSync(join(b.ws, 'context'), { recursive: true });
  symlinkSync(join(b.top, 'outside'), join(b.ws, 'context'));
  assert.throws(() => contextSync(b.ws), /symbolic link/);
  assert.equal(existsSync(join(b.top, 'outside', 'style.md')), false);
});

test('context search returns the relevant section first, applies privacy rules, and labels context as guidance', () => {
  const { ws } = biz();
  const r = contextSearch(ws, 'tracker status stage outcome');
  assert.equal(r.results[0].heading, 'Tracker status'); assert.equal(r.results[0].catalog_id, 'process');
  const all = JSON.stringify(contextSearch(ws, 'passwords notes column tools late reminders', 20));
  assert.ok(!all.includes('SECRET-ROW-TEXT') && !all.includes('Six tools came back late'), 'excluded section and redacted text never surface');
  assert.ok(contextSearch(ws, 'voice tracker').results.some((x: any) => x.visibility === 'guidance (not evidence)'));
  assert.ok(!JSON.stringify(contextSearch(ws, 'voice tracker')).includes('WRITER-ONLY-SENTINEL'));
  assert.ok(!all.includes('Private data that must never'), 'out-of-root catalog entry is not readable');
  assert.ok(!JSON.stringify(contextSearch(ws, 'walked process corrected three')).includes('I walked the process'), 'restricted catalog passages do not reach the host');
});

test('catalog evidence: one section, privacy rules recorded, visibility carried, provenance header; escapes refused', () => {
  const { ws } = biz(); sessionStart(ws, 'tracker status newsletter idea', 'ts-one');
  const e = evidenceAddCatalog(ws, 'ts-one', 'process', 'Tracker status') as any;
  const body = readFileSync(join(ws, e.path), 'utf8');
  assert.match(body, /"catalog_id": "process"/); assert.match(body, /"cleaned_sha256": "[0-9a-f]{64}"/);
  assert.ok(body.includes('Rejected, Job Closed') && !body.includes('Reminders'));
  assert.deepEqual(e.privacy_rules_applied, ['excluded section', 'redacted configured value', 'redacted configured value']);
  assert.ok(!body.includes('Six tools came back late this week.'));
  assert.ok(!body.includes('Credentials'));
  assert.equal((evidenceAddCatalog(ws, 'ts-one', 'journal') as any).visibility, 'restricted');
  assert.throws(() => evidenceAddCatalog(ws, 'ts-one', 'escape'), /outside allowed_roots/);
  assert.throws(() => evidenceAddCatalog(ws, 'ts-one', 'process', 'No such heading'), /not found/);
});

test('catalog symlink escaping the allowed root is refused', () => {
  const { ws, docs, top } = biz();
  symlinkSync(join(top, 'outside', 'secret.md'), join(docs, 'link.md'));
  const p = JSON.parse(readFileSync(join(ws, 'studio-business.json'), 'utf8'));
  p.catalog.push({ id: 'link', path: '${DOCS}/link.md', visibility: 'approved', description: 'symlink' });
  writeFileSync(join(ws, 'studio-business.json'), JSON.stringify(p));
  sessionStart(ws, 'tracker status newsletter idea', 'ts-link');
  assert.throws(() => evidenceAddCatalog(ws, 'ts-link', 'link'), /outside allowed_roots/);
});

test('host evidence keeps URI, revision, retriever and visibility; refuses missing revision, bad retriever and summaries', () => {
  const { ws, top } = biz(); sessionStart(ws, 'tracker status newsletter idea', 'ts-host');
  const page = join(top, 'page.txt'); writeFileSync(page, 'A status field should record one thing. '.repeat(5));
  const w = evidenceAddHost(ws, 'ts-host', { kind: 'web', uri: 'https://example.org/status', file: page, retrieved_by: 'claude-code:WebFetch', title: 'Example' }) as any;
  assert.equal(w.visibility, 'approved'); assert.match(readFileSync(join(ws, w.path), 'utf8'), /"retrieved_by": "claude-code:WebFetch"/);
  assert.throws(() => evidenceAddHost(ws, 'ts-host', { kind: 'github', uri: 'https://github.com/o/r/blob/main/x.md', file: page, retrieved_by: 'codex:github' }), /needs --revision/);
  const g = evidenceAddHost(ws, 'ts-host', { kind: 'gdrive', uri: 'gdrive:abc123', file: page, retrieved_by: 'chatgpt:google-drive', revision: 'rev7' }) as any;
  assert.equal(g.visibility, 'restricted'); // connector content defaults to restricted
  assert.throws(() => evidenceAddHost(ws, 'ts-host', { kind: 'web', uri: 'https://x.org', file: page, retrieved_by: 'WebFetch' }), /host:tool/);
  writeFileSync(page, 'too short'); assert.throws(() => evidenceAddHost(ws, 'ts-host', { kind: 'web', uri: 'https://x.org', file: page, retrieved_by: 'claude-code:WebFetch' }), /50\.\.150000/);
});

test('no run without an approved direction; a direction needs evidence and the approver\'s own words', () => {
  const { ws } = biz(); sessionStart(ws, 'tracker status newsletter idea', 'ts-gate');
  assert.throws(() => sessionRun(ws, 'ts-gate', { model: new FixtureModel(script()) }), /approved direction/);
  assert.throws(() => directionApprove(ws, 'ts-gate', direction(ws)), /at least one evidence/);
  evidenceAddCatalog(ws, 'ts-gate', 'process', 'Tracker status');
  assert.throws(() => directionApprove(ws, 'ts-gate', direction(ws, { approval: { type: 'owner', quote: '' } })), /own words/);
  assert.throws(() => directionApprove(ws, 'ts-gate', direction(ws, { approval: { type: 'model', quote: 'looks good' } })), /owner\|test-authorization/);
  assert.equal(directionApprove(ws, 'ts-gate', direction(ws)).state, 'direction_approved');
  assert.throws(() => evidenceAddCatalog(ws, 'ts-gate', 'journal'), /only be added while discussing/);
});

test('approved direction selects conversion specialist in the shared Runner', () => {
  const { ws } = biz(); sessionStart(ws, 'A fictional website copy request', 'copy-request');
  evidenceAddCatalog(ws, 'copy-request', 'process', 'Tracker status');
  assert.throws(() => directionApprove(ws, 'copy-request', direction(ws, { specialist: 'unknown' })), /Unknown specialist/);
  directionApprove(ws, 'copy-request', direction(ws, { specialist: 'conversion-copywriting' }));
  const m = new FixtureModel(script({
    director: () => JSON.stringify(brief({ evidence_plan: [{ point: 'status', source_ids: ['src_1'] }] })),
    writer: () => JSON.stringify(draft({ claims: draft().claims.map(c => ({ ...c, source_ids: ['src_1'] })) })),
    fact_reviewer: () => JSON.stringify(facts(facts().claims.map(c => ({ ...c, verdict: 'not_checked' })))),
  }));
  const out = sessionRun(ws, 'copy-request', { model: m }) as any;
  assert.equal(out.status, 'WAITING_FOR_OWNER');
  assert.equal(JSON.parse(readFileSync(join(ws, 'sessions/copy-request/request.json'), 'utf8')).specialist, 'conversion-copywriting');
  assert.match(m.calls.find(c => c.role === 'writer')!.system, /specialists\/copywriting\/AGENT.md/);
});

test('end to end: conversation state -> generated request -> existing Runner -> WAITING_FOR_OWNER -> existing approve', () => {
  const { ws, top } = biz(); sessionStart(ws, 'tracker status newsletter idea', 'ts-e2e');
  const profile = JSON.parse(readFileSync(join(ws, 'studio-business.json'), 'utf8'));
  profile.catalog.find((c: any) => c.id === 'journal').visibility = 'approved';
  writeFileSync(join(ws, 'studio-business.json'), JSON.stringify(profile));
  evidenceAddCatalog(ws, 'ts-e2e', 'process', 'Tracker status'); evidenceAddCatalog(ws, 'ts-e2e', 'journal');
  const note = join(top, 'plan.md'); writeFileSync(note, '# Strategy\n\nThree angles considered; recommend the status-field angle.');
  sessionNote(ws, 'ts-e2e', 'strategy', note);
  directionApprove(ws, 'ts-e2e', direction(ws, { approval: { type: 'test-authorization', quote: 'Test this with a genuinely new topic' } }));
  const two = (ids: string[]) => ids.map(s => s === 'src_3' ? 'src_2' : s);
  const m = new FixtureModel(script({
    director: () => JSON.stringify(brief({ evidence_plan: [{ point: 'status mixes three things', source_ids: ['src_1'] }, { point: 'walked the process', source_ids: ['src_2'] }] })),
    writer: () => JSON.stringify(draft({ claims: draft().claims.map(c => ({ ...c, source_ids: two(c.source_ids) })) })),
    fact_reviewer: () => JSON.stringify(facts(facts().claims.map(c => ({ ...c, verdict: 'not_checked' })))),
  }));
  const out = sessionRun(ws, 'ts-e2e', { model: m }) as any;
  assert.equal(out.status, 'WAITING_FOR_OWNER'); assert.match(out.package, /review-package\.md$/);
  assert.ok(!JSON.stringify(m.calls).includes('PRIVATE-REDACTION-SENTINEL-5389'));
  assert.ok(!JSON.stringify(m.calls).includes('SECRET-ROW-TEXT'));
  const req = JSON.parse(readFileSync(join(ws, 'sessions/ts-e2e/request.json'), 'utf8'));
  assert.deepEqual(req.restricted_sources, []);
  assert.equal(req.approved_direction.approval_type, 'test-authorization');
  const dir = m.calls.find(c => c.role === 'director')!.prompt;
  assert.match(dir, /TEST AUTHORIZATION, not owner approval: "Test this with a genuinely new topic"/);
  assert.match(dir, /Do not substitute a different angle/);
  assert.match(m.calls.find(c => c.role === 'writer')!.prompt, /<provenance note="Where this source came from\. For verification only; never quote or mention it in the article\.">\n\{\n  "kind": "catalog"/);
  assert.ok(!m.calls.find(c => c.role === 'writer')!.prompt.includes('<!-- studio evidence'));
  const st = sessionStatus(ws, 'ts-e2e')[0] as any;
  assert.equal(st.state, 'in_review'); assert.equal(st.run.status, 'WAITING_FOR_OWNER'); assert.ok(st.notes[0].endsWith('01-strategy.md'));
  assert.throws(() => approveAgentRun(ws, st.run.run_id, st.run.digest), /no owner decision/); // existing owner controls still apply
  const dec = join(top, 'decisions.json');
  writeFileSync(dec, JSON.stringify({ schema_version: 'studio.owner-decisions/0.1', decisions: Object.fromEntries(st.run.blockers.map((b: string) => [b, { decision: 'remove_before_publication', reason: 'fixture run, not for publication' }])) }));
  assert.equal((approveAgentRun(ws, st.run.run_id, st.run.digest, dec) as any).status, 'ASSET_APPROVED');
});

test('evidence changed after direction approval blocks the run', () => {
  const { ws } = biz(); sessionStart(ws, 'tracker status newsletter idea', 'ts-tamper');
  const e = evidenceAddCatalog(ws, 'ts-tamper', 'process', 'Tracker status') as any;
  directionApprove(ws, 'ts-tamper', direction(ws));
  appendFileSync(join(ws, e.path), '\nEdited after approval.');
  assert.throws(() => sessionRun(ws, 'ts-tamper', { model: new FixtureModel(script()) }), /Evidence changed/);
});

test('context-sync copies guidance into context/ with provenance; the Runner rejects malformed approved_direction', () => {
  const { ws } = biz();
  const r = contextSync(ws) as any;
  assert.equal(r.synced[0].to, 'context/style.md');
  assert.match(readFileSync(join(ws, 'context/style.md'), 'utf8'), /^<!-- Synced from \$\{DOCS\}\/style.md \(sha256 [0-9a-f]{64}/);
  const good = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/agent-sample/request.json'), 'utf8'));
  assert.throws(() => validateAgentRequest({ ...good, approved_direction: { angle: 'x' } }), /approved_direction needs/);
  assert.throws(() => validateAgentRequest({ ...good, approved_direction: { reader_question: 'q', angle: 'a', reader_promise: 'p', exclusions: [], approval_type: 'model', approval_quote: 'ok' } }), /approved_direction needs/);
});

test('context sync cannot launder restricted catalog evidence into guidance', () => {
  const { ws } = biz(); const p = join(ws, 'studio-business.json');
  const profile = JSON.parse(readFileSync(p, 'utf8'));
  profile.context_sync = [{ from: '${DOCS}/journal.md', to: 'context/leak.md' }];
  writeFileSync(p, JSON.stringify(profile));
  assert.throws(() => contextSync(ws), /explicitly approved catalog source/);
  assert.throws(() => readFileSync(join(ws, 'context/leak.md')));
});

test('context sync rejects uncataloged files and applies catalog privacy rules', () => {
  const { ws, docs } = biz(); const p = join(ws, 'studio-business.json');
  writeFileSync(join(docs, 'uncataloged.md'), 'PRIVATE-UNCATALOGED-SENTINEL');
  const profile = JSON.parse(readFileSync(p, 'utf8'));
  profile.context_sync = [{ from: '${DOCS}/uncataloged.md', to: 'context/leak.md' }];
  writeFileSync(p, JSON.stringify(profile));
  assert.throws(() => contextSync(ws), /explicitly approved catalog source/);
  profile.context_sync = [{ from: '${DOCS}/process.md', to: 'context/clean.md' }];
  writeFileSync(p, JSON.stringify(profile)); contextSync(ws);
  const synced = readFileSync(join(ws, 'context/clean.md'), 'utf8');
  assert.ok(!synced.includes('SECRET-ROW-TEXT'));
  assert.ok(!synced.includes('Six tools came back late this week.'));
  assert.ok(synced.includes('Rejected, Job Closed'));
});


test('evidence-remove drops a source only while discussing; its file is deleted and the run never sees it', () => {
  const { ws } = biz(); sessionStart(ws, 'tracker status newsletter idea', 'ts-rm');
  const j = evidenceAddCatalog(ws, 'ts-rm', 'journal') as any; evidenceAddCatalog(ws, 'ts-rm', 'process', 'Tracker status');
  assert.deepEqual((evidenceRemove(ws, 'ts-rm', j.path) as any).remaining, ['sources/ts-rm/process-tracker-status.md']);
  assert.throws(() => readFileSync(join(ws, j.path)));
  assert.throws(() => evidenceRemove(ws, 'ts-rm', 'sources/ts-rm/nope.md'), /No evidence/);
  directionApprove(ws, 'ts-rm', direction(ws));
  assert.throws(() => evidenceRemove(ws, 'ts-rm', 'sources/ts-rm/process-tracker-status.md'), /only be removed while discussing/);
});

 test('session with restricted evidence fails before changing state or calling a model', () => {
  const { ws } = biz(); sessionStart(ws, 'tracker status newsletter idea', 'ts-restricted');
  evidenceAddCatalog(ws, 'ts-restricted', 'journal'); directionApprove(ws, 'ts-restricted', direction(ws));
  const m = new FixtureModel(script());
  assert.throws(() => sessionRun(ws, 'ts-restricted', { model: m }), /Restricted evidence/);
  assert.equal(m.calls.length, 0);
  assert.equal(sessionStatus(ws, 'ts-restricted')[0].state, 'direction_approved');
});

test('direct requests cannot downgrade session evidence or introduce an unregistered copy', () => {
  const { ws } = biz(); sessionStart(ws, 'tracker status newsletter idea', 'ts-authority');
  const evidence = evidenceAddCatalog(ws, 'ts-authority', 'journal') as any;
  const original = readFileSync(join(ws, evidence.path), 'utf8');
  const changed = original.replace('"visibility": "restricted"', '"visibility": "approved"');
  writeFileSync(join(ws, evidence.path), changed);
  const request = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/agent-sample/request.json'), 'utf8'));
  Object.assign(request, { workspace_id: 'test-biz', provider: 'fixture', source_paths: [evidence.path] }); delete request.restricted_sources;
  const reqPath = join(ws, 'direct-request.json'); writeFileSync(reqPath, JSON.stringify(request));
  const model = new FixtureModel(script());
  assert.throws(() => startAgentRun(ws, reqPath, { model }), /classification or digest changed/);
  const copy = 'sources/uncataloged-copy.md'; writeFileSync(join(ws, copy), changed);
  request.source_paths = [copy]; writeFileSync(reqPath, JSON.stringify(request));
  assert.throws(() => startAgentRun(ws, reqPath, { model }), /lacks trusted session evidence or workspace registry/);
  assert.equal(model.calls.length, 0);
});

test('a trusted catalog restriction overrides an older approved evidence snapshot', () => {
  const { ws } = biz(); sessionStart(ws, 'tracker status newsletter idea', 'ts-reclass');
  const evidence = evidenceAddCatalog(ws, 'ts-reclass', 'process', 'Tracker status') as any;
  const profilePath = join(ws, 'studio-business.json'); const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  profile.catalog.find((x: any) => x.id === 'process').visibility = 'restricted'; writeFileSync(profilePath, JSON.stringify(profile));
  const request = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/agent-sample/request.json'), 'utf8'));
  Object.assign(request, { workspace_id: 'test-biz', provider: 'fixture', source_paths: [evidence.path] });
  const reqPath = join(ws, 'direct-request.json'); writeFileSync(reqPath, JSON.stringify(request));
  const model = new FixtureModel(script());
  assert.throws(() => startAgentRun(ws, reqPath, { model }), /Restricted evidence/);
  assert.equal(model.calls.length, 0);
});

test('failed session does not recreate a missing run database while inspecting latest run', () => {
  const { ws } = biz(); sessionStart(ws, 'tracker status newsletter idea', 'ts-missing-db');
  evidenceAddCatalog(ws, 'ts-missing-db', 'process', 'Tracker status'); directionApprove(ws, 'ts-missing-db', direction(ws));
  let checks = 0;
  const model = { get provider() { if (++checks === 1) return 'fixture'; unlinkSync(join(ws, '.studio', 'runs.sqlite')); throw new Error('synthetic provider error'); } } as any;
  assert.throws(() => sessionRun(ws, 'ts-missing-db', { model }), /synthetic provider error/);
  assert.equal(existsSync(join(ws, '.studio', 'runs.sqlite')), false);
  assert.equal(sessionStatus(ws, 'ts-missing-db')[0].state, 'run_failed');
});

test('a failed launch never attaches an earlier unrelated run; a created failed run remains attached', () => {
  const { ws } = biz();
  const setup = (slug: string) => { sessionStart(ws, 'tracker status newsletter idea', slug); evidenceAddCatalog(ws, slug, 'process', 'Tracker status'); directionApprove(ws, slug, direction(ws)); };
  setup('ts-first');
  const first = sessionRun(ws, 'ts-first', { model: new FixtureModel(script({ director: () => JSON.stringify({ decision: 'insufficient_evidence', reason: 'Fixture has insufficient evidence.' }) })) }) as any;
  setup('ts-second');
  let checks = 0;
  const mismatch = { get provider() { return ++checks === 1 ? 'fixture' : 'other'; } } as any;
  assert.throws(() => sessionRun(ws, 'ts-second', { model: mismatch }), /Injected model does not match/);
  assert.equal(sessionStatus(ws, 'ts-second')[0].run, null);
  assert.equal(sessionStatus(ws, 'ts-first')[0].run.run_id, first.run_id);
  setup('ts-third');
  const outage = new FixtureModel(script({ director: () => { throw new Error('synthetic provider outage'); } }));
  assert.throws(() => sessionRun(ws, 'ts-third', { model: outage }), /synthetic provider outage/);
  const failed = sessionStatus(ws, 'ts-third')[0].run;
  assert.ok(failed.run_id && failed.run_id !== first.run_id);
  assert.equal(failed.status, 'FAILED_RECOVERABLE');
});

test('session-run carries host and session so a scoped source grant can be checked; wrong or missing host fails closed', () => {
  const { ws } = biz(); const root = realpathSync(ws); sessionStart(ws, 'tracker status newsletter idea', 'ts-grant');
  const ev = evidenceAddCatalog(ws, 'ts-grant', 'journal') as any; directionApprove(ws, 'ts-grant', direction(ws));
  const gf = join(ws, 'grant.json');
  writeFileSync(gf, JSON.stringify({ workspace_id: 'test-biz', session: 'ts-grant', host: 'codex', purpose: 'drafting', roles: ['director', 'writer', 'fact_reviewer'], source_path: ev.path, excerpts: ['Rejected is not a stage.'], owner_authorization: 'Only that sentence may be used.' }));
  const m0 = new FixtureModel(script());
  assert.throws(() => sessionRun(ws, 'ts-grant', { model: m0 }), /Restricted evidence.*no_context/);
  assert.throws(() => sessionRun(ws, 'ts-grant', { model: m0, host: 'codex' }), /Restricted evidence.*no_grant/);
  sourceDisclosureGrant(root, gf, inspectSource);
  assert.throws(() => sessionRun(ws, 'ts-grant', { model: m0, host: 'chatgpt' }), /Restricted evidence.*scope_mismatch/);
  assert.equal(m0.calls.length, 0); assert.equal(sessionStatus(ws, 'ts-grant')[0].state, 'direction_approved');
  const m = new FixtureModel(script({ director: () => JSON.stringify({ decision: 'insufficient_evidence', reason: 'Only one sentence is available.' }) }));
  const out = sessionRun(ws, 'ts-grant', { model: m, host: 'codex' }) as any;
  assert.equal(out.status, 'BLOCKED_EVIDENCE');
  assert.ok(m.calls[0].prompt.includes('Rejected is not a stage.')); assert.ok(!m.calls[0].prompt.includes('I walked the process'));
  assert.deepEqual(JSON.parse(readFileSync(join(ws, 'sessions', 'ts-grant', 'request.json'), 'utf8')).disclosure, { session: 'ts-grant', host: 'codex' });
});
