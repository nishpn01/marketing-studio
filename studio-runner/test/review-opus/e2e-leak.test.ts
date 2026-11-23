/**
 * Opus final review: end-to-end leak proof. One business workspace holds an approved catalog doc with an excluded
 * heading and a redacted string, a restricted catalog doc (one granted line, one never-granted line), a restricted
 * capture and an approved capture with a profile-redacted string. We run ungranted, then narrowly granted, then
 * revise with owner feedback, approve, hand off, and file an improvement brief, and check every model-visible
 * input (system + prompt of every role call, and the handoff reader prompt) plus every file the Runner wrote.
 * Synthetic sentinels only; FixtureModel; no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bizWs, direction, dump, S } from '../adversarial/harness.ts';
import { sessionStart, evidenceAddCatalog, directionApprove, sessionRun, contextSearch } from '../../src/director-session.ts';
import { reviseAgentRun, approveAgentRun, inspectSource, ALLOWED } from '../../src/agent-run.ts';
import { sourceDisclosureGrant } from '../../src/source-disclosure.ts';
import { captureImport } from '../../src/conversation-capture.ts';
import { handoffPromptFor } from '../../src/handoff.ts';
import { improvementPropose, improvementHandoff } from '../../src/improvement.ts';
import { FixtureModel } from '../../src/model-port.ts';
import { DRAFT, craft } from '../helpers/fixture-script.ts';

const GRANTED = 'GRANTED-LINE-9001: nine of fourteen members waited for a late tool';
const NEVER = 'NEVER-GRANTED-9002 private diary figure';
const CAP_RESTRICTED = 'CAPTURE-RESTRICTED-9003', CAP_REDACT = 'CAPTURE-PROFILE-REDACT-9004', CAP_OK = 'capture-approved-marker-9005';
const FORBIDDEN = [S.secretHeading, S.redact, NEVER, CAP_RESTRICTED, CAP_REDACT, S.restrictedDoc];

const model = () => { let w = 0; return new FixtureModel((req) => {
  switch (req.role) {
    case 'director': return JSON.stringify({ decision: 'proceed', reason: 'r', reader_question: 'Why track by hand first?', angle: 'Walk the real work first', alternatives_considered: [{ angle: 'a', why_not: 'b' }, { angle: 'c', why_not: 'd' }], reader_promise: 'Check one field against reality', evidence_plan: [{ point: 'p', source_ids: ['src_1', 'src_2'] }], exclusions: [], open_questions_for_owner: [], length_words: 300 });
    case 'writer': return JSON.stringify({ title: 'T', draft_markdown: DRAFT + (++w > 1 ? `\n\nRevision ${w}.` : ''), notes_for_owner: [], claims: [{ id: 'c01', text: 'Six tools came back late.', draft_quote: 'Six tools came back late this week.', source_ids: ['src_1'] }] });
    case 'fact_reviewer': return JSON.stringify({ claims: [{ claim_id: 'c01', verdict: 'not_checked' }], unlisted_claims: [], summary: 's' });
    case 'craft_reviewer': return JSON.stringify(craft());
    default: throw new Error(req.role);
  }
}); };

function workspace() {
  const b = bizWs([], { 'journal.md': `# Journal\n\n${GRANTED}.\n\n${NEVER} and ${S.restrictedDoc}.\n` }, { capture: { enabled: true, allowed_hosts: ['codex'], redact: [CAP_REDACT] } });
  const t1 = join(b.top, 'r.txt'); writeFileSync(t1, `Owner: The ${CAP_RESTRICTED} plan stays between us.\nAssistant: Noted.\n`);
  captureImport(b.ws, { file: t1, host: 'codex', format: 'text', authorization: 'Owner authorised this import', title: 'restricted chat' });
  const t2 = join(b.top, 'a.txt'); writeFileSync(t2, `Owner: We chose stickers, ${CAP_OK}, and ${CAP_REDACT} is my landlord.\nAssistant: Noted.\n`);
  captureImport(b.ws, { file: t2, host: 'codex', format: 'text', authorization: 'Owner authorised this import', title: 'approved chat', visibility: 'approved' });
  const slug = 'leak-proof';
  sessionStart(b.ws, 'A synthetic newsletter about hand tracking first', slug);
  evidenceAddCatalog(b.ws, slug, 'process'); // approved, with excluded heading + redaction
  const j = evidenceAddCatalog(b.ws, slug, 'journal'); // restricted
  directionApprove(b.ws, slug, direction(b.ws, { notes: 'Owner note: keep it short.' }));
  return { ...b, slug, journal: j.path as string };
}
const all = (m: FixtureModel) => m.calls.map(c => `${c.system}\n${c.prompt}`).join('\n=====\n');
const noneOf = (hay: string, where: string) => { for (const s of FORBIDDEN) assert.ok(!hay.includes(s), `${s} leaked into ${where}`); };

test('E2E: ungranted restricted evidence refuses before any model call and writes no restricted text', () => {
  const w = workspace(); const m = model();
  assert.throws(() => sessionRun(w.ws, w.slug, { model: m, host: 'codex' }), /scoped disclosure not valid \(no_grant\)/);
  assert.equal(m.calls.length, 0);
  noneOf(dump(join(w.ws, '.studio')) + dump(join(w.ws, 'sessions')), '.studio/ or sessions/');
});

test('E2E: narrow grant -> only the granted line reaches only the granted roles, through run, revise, approve, handoff and improvement', () => {
  const w = workspace();
  const gf = join(w.top, 'grant.json');
  writeFileSync(gf, JSON.stringify({ workspace_id: 'adv-biz', session: w.slug, host: 'codex', purpose: 'drafting', roles: ['director', 'writer', 'fact_reviewer'], source_path: w.journal, excerpts: [GRANTED], owner_authorization: 'Use only the first line please.' }));
  sourceDisclosureGrant(w.ws, gf, inspectSource);
  const m = model();
  const out = sessionRun(w.ws, w.slug, { model: m, host: 'codex' }) as any;
  assert.equal(out.status, 'WAITING_FOR_OWNER');
  noneOf(all(m), 'a model role');
  for (const c of m.calls) assert.equal(c.prompt.includes(GRANTED), c.role !== 'craft_reviewer', `granted line visibility for ${c.role}`);
  assert.ok(!all(m).includes('Use only the first line please'), 'owner grant quote never reaches a role');

  // Owner revision (feedback text is owner input and goes to the writer by design).
  const fb = join(w.top, 'fb.md'); writeFileSync(fb, 'Please tighten the opening paragraph a little.');
  const before = m.calls.length; const snap1 = JSON.parse(readFileSync(join(out.artifact_dir, 'run-snapshot.json'), 'utf8'));
  const rv = reviseAgentRun(w.ws, out.run_id, fb, { model: m }) as any;
  assert.equal(rv.status, 'WAITING_FOR_OWNER'); assert.equal(rv.version, 'v002');
  const revCalls = m.calls.slice(before);
  noneOf(revCalls.map(c => c.system + c.prompt).join('\n'), 'a revise-phase role');
  assert.ok(revCalls.find(c => c.role === 'writer')!.prompt.includes('Owner feedback (authoritative):\nPlease tighten'));

  // Approval is bound to the reviewed v002 digest; the v001 digest is refused.
  const snap2 = JSON.parse(readFileSync(join(out.artifact_dir, 'run-snapshot.json'), 'utf8'));
  assert.throws(() => approveAgentRun(w.ws, out.run_id, snap1.current_digest), /Stale or wrong digest/);
  const blockers = JSON.parse(readFileSync(join(out.artifact_dir, `blockers-${snap2.current_version}.json`), 'utf8')).blockers as any[];
  const dec: any = {}; for (const b of blockers) dec[b.id] = { decision: ALLOWED[b.kind === 'claim' ? `claim_${b.verdict}` : b.kind][0], reason: 'Owner accepted this in review.' };
  const df = join(w.top, 'dec.json'); writeFileSync(df, JSON.stringify({ schema_version: 'studio.owner-decisions/0.1', decisions: dec }));
  assert.equal((approveAgentRun(w.ws, out.run_id, snap2.current_digest, df) as any).version, 'v002');

  // Handoff reader input.
  const h = handoffPromptFor(w.ws, out.run_id); noneOf(h.system + h.user, 'handoff prompt'); assert.ok(!h.user.includes(GRANTED));

  // Improvement brief referencing the restricted evidence: references carry hashes, not text.
  const pf = join(w.top, 'prop.json');
  writeFileSync(pf, JSON.stringify({ owner_request: 'Please look into why the journal was hard to use.', title: 'Journal source is awkward', finding: 'The journal source needed a grant to be used at all.', proposed_change: 'Split the journal into public and private files.', affected: ['catalog:journal'], references: [{ kind: 'evidence', ref: w.journal }, { kind: 'session_artifact', ref: 'review-package.md' }] }));
  const imp = improvementPropose(w.ws, w.slug, pf, 'claude-code:marketing-director') as any;
  const brief = readFileSync(join(w.ws, (improvementHandoff(w.ws, imp.id, 'codex') as any).handoff), 'utf8');
  noneOf(brief, 'improvement brief'); assert.ok(!brief.includes(GRANTED));

  // Every file the Runner wrote, except the restricted evidence copy itself and the grant (which must hold the excerpt).
  const files = dump(join(w.ws, '.studio', 'artifacts')) + dump(join(w.ws, 'sessions')) + dump(join(w.ws, 'improvements')) + readFileSync(join(w.ws, 'sources', w.slug, 'process.md'), 'utf8');
  noneOf(files, 'artifacts/sessions/improvements/approved evidence');
  // Context search: approved capture is searchable with its profile string redacted; the restricted capture is absent.
  const cs = JSON.stringify(contextSearch(w.ws, 'stickers landlord plan', 20));
  assert.ok(cs.includes(CAP_OK)); noneOf(cs, 'context-search');
});
