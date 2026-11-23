/** Fake-host driver for series tests: idea -> plan in Linear -> plan approval -> reviewed piece, using the fake Linear adapter and real Runner QA artifacts. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StudioService, fixtureModel } from "../../src/service/studio-service.ts";
import { reviseAgentRun, startAgentRun } from "../../src/agent-run.ts";
import { FixtureModel, type ModelPort } from "../../src/model-port.ts";
import { FakeLinearAdapter } from "../../src/service/linear-boundary.ts";
import { REPO_ROOT } from "../../src/runner.ts";
import { DRAFT, draft, facts, script } from "./fixture-script.ts";

export const LINEAR_ACCOUNT = "linear-owner";
const guide = (studio: StudioService) => {
  mkdirSync(join(studio.workspace, "docs"), { recursive: true });
  writeFileSync(join(studio.workspace, "docs", "guide.md"), "# Guide\nSynthetic service context for the fictional tool library.");
};
const shape = (count: number, format = "text") => ({ kind: "series", title: "Synthetic Studio series", objective: "Teach a safe workflow", audience: "fictional readers", audience_promise: "One useful implementation lesson per piece", format_policy: [format], requested_piece_count: count, scope: "Synthetic Service acceptance", exclusions: ["No private facts"] });

export type QaFailure = "unsupported" | "unchecked" | "unlisted" | "craft-revise" | "craft-must";
/** Runner model whose fact or craft review fails one specific way, to produce a real WAITING_FOR_OWNER run that still has blockers. */
export function failingModel(kind: QaFailure) {
  const claim = (id: string, excerpt: string, verdict = "verified") => ({ claim_id: id, verdict, source_id: `src_${Number(id.slice(1))}`, source_excerpt: excerpt, note: verdict === "verified" ? "" : "not in the cited source" });
  const ok = [claim("c01", "Six tools came back late this week."), claim("c02", "9 of them said they had waited for a tool that was out late."), claim("c03", "test automated reminder texts for one month before buying booking software")];
  const withClaim2 = (second: object, unlisted: object[] = []) => JSON.stringify(facts([ok[0], second, ok[2]], unlisted));
  const craftOf = (verdict: string) => JSON.stringify({ verdict, reader_promise_met: false, strengths: [], findings: [{ excerpt: "There is no result yet", problem: "Weak close", suggestion: "Rewrite", severity: "must" }], summary: "fixture" });
  const overrides = {
    unsupported: { fact_reviewer: () => withClaim2({ claim_id: "c02", verdict: "unsupported", note: "not in the cited source" }) },
    // A "verified" label whose excerpt is not in the source: the Runner downgrades it to not_checked.
    unchecked: { fact_reviewer: () => withClaim2(claim("c02", "an excerpt that never appears in any permitted source")) },
    unlisted: { fact_reviewer: () => withClaim2(ok[1], [{ draft_excerpt: "two weeks later", problem: "A dated claim with no listed source" }]) },
    "craft-revise": { craft_reviewer: () => craftOf("revise") },
    // The reviewer calls it ready but still lists a must-fix finding.
    "craft-must": { craft_reviewer: () => craftOf("ready") },
  }[kind];
  return new FixtureModel(script(overrides));
}

/** A completed Runner run whose current version is at least minVersion; the last step uses lastModel. */
export function runnerRun(studio: StudioService, minVersion: number, lastModel: ModelPort = fixtureModel()) {
  const requestFile = join(studio.workspace, "request.json");
  const request = JSON.parse(readFileSync(join(REPO_ROOT, "studio-runner/fixtures/agent-sample/request.json"), "utf8"));
  request.provider = "fixture";
  writeFileSync(requestFile, JSON.stringify(request));
  let result: any = startAgentRun(studio.workspace, requestFile, { model: minVersion === 1 ? lastModel : fixtureModel() });
  for (let current = 2; current <= minVersion; current++) {
    const feedback = join(studio.workspace, `feedback-${current}.md`);
    writeFileSync(feedback, `Please make revision ${current} more concrete.`);
    result = reviseAgentRun(studio.workspace, result.run_id, feedback, { model: current === minVersion ? lastModel : fixtureModel() });
  }
  const snapshot = JSON.parse(readFileSync(join(result.artifact_dir, "run-snapshot.json"), "utf8"));
  const version = snapshot.current_version as string;
  return { run_id: result.run_id as string, artifact_dir: result.artifact_dir as string, version, body: readFileSync(join(result.artifact_dir, `draft-${version}.md`), "utf8"), source_index_digest: snapshot.source_manifest_digest as string };
}
export { DRAFT, draft };

export class Flow {
  readonly studio: StudioService;
  readonly linear = new FakeLinearAdapter();
  program = "";
  evidence = "";
  pieces: { id: string; ordinal: number }[] = [];
  changeSet: unknown = null;
  constructor(studio: StudioService) { this.studio = studio; }
  call(name: string, args: Record<string, unknown>): any { return this.studio.callTool(name, args); }
  planKey() { return `msc:${this.studio.tenantId}:program:${this.program}:plan`; }
  draftKey(pieceId: string) { return `msc:${this.studio.tenantId}:program:${this.program}:piece:${pieceId}:draft`; }
  /** Fresh read of the piece document, as a host connector would return it. */
  read(pieceId: string) { return this.linear.readDocument(this.draftKey(pieceId)); }
  document(pieceId: string) { const { document_id, external_revision, body } = this.read(pieceId); return { document_id, external_revision, body }; }
  status(pieceId: string) { return this.call("piece_status", { program_id: this.program, piece_id: pieceId }).result; }
  /** idea -> shape -> saved plan -> change set applied in the fake Linear and reconciled. Plan approval is the caller's. */
  plan(session: string, count = 2, sync = true, format: "text" | "video" = "text") {
    const studio = this.studio;
    guide(studio);
    assert.equal(this.call("session_start", { idea: "A synthetic series idea that is safe to test", slug: session }).ok, true);
    const evidence = this.call("evidence_add_catalog", { session, catalog_id: "guide" });
    assert.equal(evidence.ok, true);
    this.evidence = evidence.result.path;
    const proposal = this.call("work_shape_propose", { session, ...shape(count, format) });
    const confirmed = this.call("program_shape_confirm", { shape_id: proposal.result.shape_id });
    this.program = confirmed.result.program_id;
    const pieceOne = "piece-" + hashHex(this.program + ":1");
    const saved = this.call("program_plan_save", { program_id: this.program, pieces: Array.from({ length: count }, (_, index) => ({ ordinal: index + 1, title: `Piece ${index + 1}`, format, angle: `A distinct safe angle ${index + 1}`, audience_promise: `A useful promise ${index + 1}`, evidence_refs: [this.evidence], ...(index > 0 ? { prior_approved_piece_ids: [pieceOne] } : {}) })) });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    this.pieces = saved.result.pieces;
    this.changeSet = saved.result.change_set;
    if (sync) this.syncPlan(this.changeSet);
    return this;
  }
  syncPlan(changeSet: unknown) {
    assert.equal(this.call("linear_sync_reconcile", { program_id: this.program, receipt: this.linear.apply(changeSet) }).ok, true);
  }
  /** Run the Runner at minVersion, record it as a piece revision, and sync the guarded document change set. */
  draftPiece(pieceId: string, minVersion = 1, lastModel?: ModelPort) {
    const qa = runnerRun(this.studio, minVersion, lastModel);
    const revised = this.call("piece_revise", { program_id: this.program, piece_id: pieceId, revision: { version: qa.version, body: qa.body, source_index_digest: qa.source_index_digest, qa: { run_id: qa.run_id } } });
    assert.equal(revised.ok, true, JSON.stringify(revised));
    assert.equal(this.call("linear_sync_reconcile", { program_id: this.program, receipt: this.linear.apply(revised.result.change_set) }).ok, true);
    return { ...qa, revised };
  }
  /** Owner edits the document and comments in Linear; the host reads both and ingests them. Returns the revision input id. */
  ingestOwnerEdit(pieceId: string, body: string, comment = "Please tighten the opening.") {
    this.linear.editDocument(this.draftKey(pieceId), body);
    this.linear.addComment(this.draftKey(pieceId), comment);
    const read = this.read(pieceId);
    const ingested = this.call("piece_review_ingest", { program_id: this.program, piece_id: pieceId, document_id: read.document_id, external_revision: read.external_revision, body: read.body, comments: this.linear.listComments(this.draftKey(pieceId)) });
    assert.equal(ingested.result?.status, "captured", JSON.stringify(ingested));
    return ingested.result.revision_input_id as string;
  }
  /** Revision after an ingested owner edit, using the pending revision input, synced back to Linear. */
  reviseFromEdit(pieceId: string, revisionInputId: string, lastModel?: ModelPort) {
    // Ingest already advanced the piece's version, so the Runner must reach a later one.
    const qa = runnerRun(this.studio, Number(this.status(pieceId).current_revision.version.slice(1)) + 1, lastModel);
    const revised = this.call("piece_revise", { program_id: this.program, piece_id: pieceId, revision: { version: qa.version, body: qa.body, source_index_digest: qa.source_index_digest, revision_input_id: revisionInputId, qa: { run_id: qa.run_id } } });
    assert.equal(revised.ok, true, JSON.stringify(revised));
    assert.equal(this.call("linear_sync_reconcile", { program_id: this.program, receipt: this.linear.apply(revised.result.change_set) }).ok, true);
    return { ...qa, revised };
  }
  /** A marker comment from the given account on the piece (or plan) document. */
  marker(key: string, body: string, account = LINEAR_ACCOUNT) { return this.linear.addComment(key, body, { account_id: account }); }
}
import { createHash } from "node:crypto";
const hashHex = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
