import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudioService, fixtureModel } from "../src/service/studio-service.ts";
import { reviseAgentRun, startAgentRun } from "../src/agent-run.ts";
import { REPO_ROOT, hash } from "../src/runner.ts";
import { FakeLinearAdapter, FakeReceiptStore } from "../src/service/linear-boundary.ts";
import { AuthorityStore } from "../src/service/authority-store.ts";
import { ProgramStore } from "../src/service/program-store.ts";
import { TestOwnerVerifier } from "./helpers/test-owner-verifier.ts";
import { sourceWorkspace } from "./helpers/service-fixture.ts";

const verifier = new TestOwnerVerifier();
const shape = (count = 2, formatPolicy: ("text" | "video")[] = ["text"]) => ({
  kind: "series", title: "Synthetic Studio series", objective: "Teach a safe workflow", audience: "fictional readers",
  audience_promise: "One useful implementation lesson per piece", format_policy: formatPolicy, requested_piece_count: count,
  scope: "Synthetic Service acceptance", exclusions: ["No private facts"],
});
const planned = (path: string, count = 2, format: "text" | "video" = "text") => Array.from({ length: count }, (_, index) => ({
  ordinal: index + 1, title: `Piece ${index + 1}`, format, angle: `A distinct safe angle ${index + 1}`,
  audience_promise: `A useful promise ${index + 1}`, evidence_refs: [path],
}));

function service(tenantId: string) {
  const studio = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-program-data-")), tenantId, workspace: sourceWorkspace(), ownerVerifier: verifier });
  mkdirSync(join(studio.workspace, "docs"), { recursive: true });
  writeFileSync(join(studio.workspace, "docs", "guide.md"), "# Guide\nSynthetic service context for the fictional tool library.");
  return studio;
}
function plan(service: StudioService, session: string, count = 2) {
  assert.equal(service.callTool("session_start", { idea: "A synthetic series idea that is safe to test", slug: session }).ok, true);
  const evidence: any = service.callTool("evidence_add_catalog", { session, catalog_id: "guide" });
  assert.equal(evidence.ok, true);
  const proposal: any = service.callTool("work_shape_propose", { session, ...shape(count) });
  assert.equal(proposal.ok, true);
  const confirmed: any = service.callTool("program_shape_confirm", { shape_id: proposal.result.shape_id });
  assert.equal(confirmed.ok, true);
  const saved: any = service.callTool("program_plan_save", { program_id: confirmed.result.program_id, pieces: planned(evidence.result.path, count) });
  assert.equal(saved.ok, true);
  return { program: confirmed.result.program_id as string, evidence: evidence.result.path as string, saved: saved.result };
}
function prepare(service: StudioService, session: string, count = 2, formatPolicy: ("text" | "video")[] = ["text"]) {
  assert.equal(service.callTool("session_start", { idea: "A synthetic series idea that is safe to test", slug: session }).ok, true);
  const evidence: any = service.callTool("evidence_add_catalog", { session, catalog_id: "guide" });
  assert.equal(evidence.ok, true);
  const proposal: any = service.callTool("work_shape_propose", { session, ...shape(count, formatPolicy) });
  assert.equal(proposal.ok, true);
  const confirmed: any = service.callTool("program_shape_confirm", { shape_id: proposal.result.shape_id });
  assert.equal(confirmed.ok, true);
  return { program: confirmed.result.program_id as string, evidence: evidence.result.path as string };
}
function runnerRevision(studio: StudioService, version: number) {
  const requestFile = join(studio.workspace, "request.json");
  const request = JSON.parse(readFileSync(join(REPO_ROOT, "studio-runner/fixtures/agent-sample/request.json"), "utf8"));
  request.provider = "fixture";
  writeFileSync(requestFile, JSON.stringify(request));
  const model = fixtureModel();
  let result: any = startAgentRun(studio.workspace, requestFile, { model });
  for (let current = 2; current <= version; current++) {
    const feedback = join(studio.workspace, `feedback-${current}.md`);
    writeFileSync(feedback, `Please make revision ${current} more concrete.`);
    result = reviseAgentRun(studio.workspace, result.run_id, feedback, { model });
  }
  const snapshot = JSON.parse(readFileSync(join(result.artifact_dir, "run-snapshot.json"), "utf8"));
  return {
    run_id: result.run_id,
    artifact_dir: result.artifact_dir,
    body: readFileSync(join(result.artifact_dir, `draft-v${String(version).padStart(3, "0")}.md`), "utf8"),
    source_index_digest: snapshot.source_manifest_digest,
  };
}

test("Service programs preserve two- and ten-piece order, emit deterministic host output, and require an exact signed plan", async () => {
  const studio = service("program-positive-tenant");
  try {
    const two = plan(studio, "two-pieces", 2);
    assert.deepEqual(JSON.parse(readFileSync(join(studio.tenantDir, "programs", `${two.program}.json`), "utf8")).decision_ids, []);
    assert.deepEqual(two.saved.pieces.map((piece: any) => piece.ordinal), [1, 2]);
    assert.match(two.saved.pieces[0].id, /^piece-[a-f0-9]{16}$/);
    assert.equal(two.saved.change_set.schema_version, "studio.linear-change-set/0.1");
    assert.equal(two.saved.change_set.operations.length, 4, "project + plan document + two issues");
    assert.ok(!JSON.stringify(two.saved.change_set).includes("Synthetic service context"), "change sets carry refs, not source prose");
    const receipts = new FakeReceiptStore();
    assert.equal(receipts.put({ schema_version: "studio.linear-receipt/0.1", operation_id: two.saved.change_set.operation_id, idempotency_key: two.saved.change_set.idempotency_key, status: "pending", objects: [] }).status, "pending");
    assert.equal(studio.callTool("piece_draft_start", { program_id: two.program, piece_id: two.saved.pieces[0].id, direction: "Draft the first piece from the agreed angle", source_refs: [two.evidence] }).error, "DENIED");

    const pending: any = studio.callTool("program_plan_submit_for_approval", { program_id: two.program });
    assert.equal(pending.ok, true);
    assert.equal(pending.result.digest, two.saved.plan_digest, "owner approval binds the exact saved plan");
    studio.ownerDecide("approve", pending.result.request_id, pending.result.digest, verifier.assertion());
    assert.equal((studio.callTool("program_plan_status", { program_id: two.program }).result as any).approved, true);
    const start: any = studio.callTool("piece_draft_start", { program_id: two.program, piece_id: two.saved.pieces[0].id, direction: "Draft the first piece from the agreed angle", source_refs: [two.evidence] });
    assert.equal(start.ok, true);
    assert.deepEqual(start.result.prior_approved_context, []);

    const ten = plan(studio, "ten-pieces", 10);
    assert.deepEqual(ten.saved.pieces.map((piece: any) => piece.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(new Set(ten.saved.pieces.map((piece: any) => piece.id)).size, 10);

    assert.equal(studio.callTool("session_start", { idea: "A one-off idea that stays project free", slug: "one-off" }).ok, true);
    const oneOff: any = studio.callTool("work_shape_propose", { session: "one-off", ...shape(1), kind: "one_off" });
    const oneOffConfirmed: any = studio.callTool("program_shape_confirm", { shape_id: oneOff.result.shape_id });
    assert.equal(oneOffConfirmed.result.program_id, null);

    assert.equal(studio.callTool("session_start", { idea: "A video-shaped series remains format neutral", slug: "video-series" }).ok, true);
    const videoEvidence: any = studio.callTool("evidence_add_catalog", { session: "video-series", catalog_id: "guide" });
    const videoShape: any = studio.callTool("work_shape_propose", { session: "video-series", ...shape(2, ["video"]) });
    const videoProgram: any = studio.callTool("program_shape_confirm", { shape_id: videoShape.result.shape_id });
    const videoPlan: any = studio.callTool("program_plan_save", { program_id: videoProgram.result.program_id, pieces: planned(videoEvidence.result.path, 2, "video") });
    assert.equal((studio.callTool("piece_status", { program_id: videoProgram.result.program_id, piece_id: videoPlan.result.pieces[0].id }).result as any).format, "video");
    const videoPending: any = studio.callTool("program_plan_submit_for_approval", { program_id: videoProgram.result.program_id });
    studio.ownerDecide("approve", videoPending.result.request_id, videoPending.result.digest, verifier.assertion());
    assert.equal(studio.callTool("piece_draft_start", { program_id: videoProgram.result.program_id, piece_id: videoPlan.result.pieces[0].id, direction: "Draft the first video piece", source_refs: [videoEvidence.result.path] }).error, "DENIED");
  } finally { await studio.close(); }
});

test("program plans fail closed for invalid source references and malformed piece order", async () => {
  const studio = service("program-negative-tenant");
  try {
    assert.equal(studio.callTool("session_start", { idea: "A synthetic series idea that is safe to test", slug: "bad-pieces" }).ok, true);
    const evidence: any = studio.callTool("evidence_add_catalog", { session: "bad-pieces", catalog_id: "guide" });
    const proposal: any = studio.callTool("work_shape_propose", { session: "bad-pieces", ...shape(2) });
    const program: any = studio.callTool("program_shape_confirm", { shape_id: proposal.result.shape_id });
    const valid = planned(evidence.result.path);
    assert.equal(studio.callTool("program_plan_save", { program_id: program.result.program_id, pieces: [{ ...valid[0], ordinal: 0 }, valid[1]] }).error, "INVALID_REQUEST");
    assert.equal(studio.callTool("program_plan_save", { program_id: program.result.program_id, pieces: [{ ...valid[0], ordinal: 2 }, valid[1]] }).error, "INVALID_REQUEST");
    assert.equal(studio.callTool("program_plan_save", { program_id: program.result.program_id, pieces: [{ ...valid[0], ordinal: 1 }, { ...valid[1], ordinal: 1 }] }).error, "INVALID_REQUEST");
    assert.equal(studio.callTool("program_plan_save", { program_id: program.result.program_id, pieces: [{ ...valid[0], angle: "" }, valid[1]] }).error, "INVALID_REQUEST");
    assert.equal(studio.callTool("program_plan_save", { program_id: program.result.program_id, pieces: [{ ...valid[0], audience_promise: "" }, valid[1]] }).error, "INVALID_REQUEST");
    assert.equal(studio.callTool("program_plan_save", { program_id: program.result.program_id, pieces: [{ ...valid[0], evidence_refs: ["draft-v001.md"] }, valid[1]] }).error, "INVALID_REQUEST");
    assert.equal(studio.callTool("work_shape_propose", { session: "bad-pieces", ...shape(0) }).error, "INVALID_REQUEST");
  } finally { await studio.close(); }
});

test("Service source intake never snapshots restricted or escaped catalog entries into model-reachable program evidence", async () => {
  const studio = service("program-source-tenant");
  try {
    const business = JSON.parse(readFileSync(join(studio.workspace, "studio-business.json"), "utf8"));
    business.catalog[0].visibility = "restricted";
    writeFileSync(join(studio.workspace, "studio-business.json"), JSON.stringify(business));
    assert.equal(studio.callTool("session_start", { idea: "A synthetic series idea that is safe to test", slug: "restricted-source" }).ok, true);
    assert.equal(studio.callTool("evidence_add_catalog", { session: "restricted-source", catalog_id: "guide" }).error, "DENIED");
    assert.equal((studio.callTool("context_search", { query: "synthetic service context" }).result as any).results.length, 0);
    business.catalog[0].visibility = "approved";
    business.catalog.push({ id: "escape", path: "../outside.md", visibility: "approved", description: "escape" });
    writeFileSync(join(studio.workspace, "studio-business.json"), JSON.stringify(business));
    assert.equal(studio.callTool("evidence_add_catalog", { session: "restricted-source", catalog_id: "escape" }).error, "INVALID_REQUEST");
  } finally { await studio.close(); }
});

test("pending, rejected, stale, planted cross-tenant, and mismatched program requests cannot start a text piece", async () => {
  const first = service("program-first-tenant"), second = service("program-second-tenant");
  try {
    const item = plan(first, "pending-plan");
    const input = { program_id: item.program, piece_id: item.saved.pieces[0].id, direction: "Draft the first piece from the agreed angle", source_refs: [item.evidence] };
    assert.equal(first.callTool("piece_draft_start", input).error, "DENIED", "pending plan");
    const pending: any = first.callTool("program_plan_submit_for_approval", { program_id: item.program });
    first.ownerDecide("reject", pending.result.request_id, pending.result.digest, verifier.assertion());
    assert.equal(first.callTool("piece_draft_start", input).error, "DENIED", "rejected plan");
    first.ownerChannelForTesting().decide("plan_approval", "program-plan-" + item.program, { program_id: item.program, plan_digest: "0".repeat(64) }, verifier.assertion());
    assert.equal(first.callTool("piece_draft_start", input).error, "DENIED", "stale approval");
    cpSync(join(first.tenantDir, "programs", `${item.program}.json`), join(second.tenantDir, "programs", `${item.program}.json`));
    assert.equal(second.callTool("program_plan_status", { program_id: item.program }).error, "NOT_FOUND", "planted cross tenant program lookup");
    assert.equal(second.callTool("piece_draft_start", input).error, "DENIED", "cross tenant piece lookup");
    const paired = plan(first, "paired-first");
    const other = plan(first, "paired-second");
    const otherPending: any = first.callTool("program_plan_submit_for_approval", { program_id: other.program });
    first.ownerDecide("approve", otherPending.result.request_id, otherPending.result.digest, verifier.assertion());
    assert.equal(first.callTool("piece_draft_start", { program_id: other.program, piece_id: paired.saved.pieces[0].id, direction: "Draft the wrong paired piece", source_refs: [other.evidence] }).error, "DENIED", "piece belongs to another program");
    assert.ok(!first.listTools().some((tool) => /^(approve|final)/.test(tool.name)), "model tools expose no plan approval or finalization");
  } finally { await first.close(); await second.close(); }
});

test("fake Linear sync is idempotent, receipt-gated, and maps one stable object per program/piece", async () => {
  const studio = service("linear-sync-tenant");
  const linear = new FakeLinearAdapter();
  try {
    const item = plan(studio, "linear-plan", 2);
    const incompleteReceipt = { schema_version: "studio.linear-receipt/0.1" as const, operation_id: item.saved.change_set.operation_id, idempotency_key: item.saved.change_set.idempotency_key, status: "applied" as const, objects: [] };
    assert.equal(studio.callTool("linear_sync_reconcile", { program_id: item.program, receipt: incompleteReceipt }).error, "INVALID_REQUEST");
    assert.throws(() => new ProgramStore(studio.tenantDir, studio.tenantId, studio.workspace, new AuthorityStore(studio.tenantDir)).reconcileLinear(item.program, incompleteReceipt), /missing an operation object/);
    assert.equal((studio.callTool("linear_sync_status", { program_id: item.program }).result as any).changes[0].status, "pending");
    linear.failNext();
    const failed = linear.apply(item.saved.change_set);
    assert.equal(failed.status, "failed");
    assert.equal(studio.callTool("linear_sync_reconcile", { program_id: item.program, receipt: failed }).result && (studio.callTool("linear_sync_status", { program_id: item.program }).result as any).changes[0].status, "failed");
    const applied = linear.apply(item.saved.change_set);
    assert.equal(applied.status, "applied");
    assert.equal(studio.callTool("linear_sync_reconcile", { program_id: item.program, receipt: applied }).ok, true);
    assert.equal((studio.callTool("linear_sync_status", { program_id: item.program }).result as any).changes[0].status, "applied");
    assert.deepEqual(linear.counts(), { projects: 1, issues: 2, documents: 1 });
    assert.deepEqual(linear.apply(item.saved.change_set), applied, "same idempotency key returns the original receipt");

    const pending: any = studio.callTool("program_plan_submit_for_approval", { program_id: item.program });
    studio.ownerDecide("approve", pending.result.request_id, pending.result.digest, verifier.assertion());
    const piece = item.saved.pieces[0];
    const fabricated: any = studio.callTool("piece_revise", { program_id: item.program, piece_id: piece.id, revision: { version: "v001", body: "A generated review draft with enough content.", source_index_digest: "a".repeat(64), qa: { fact_digest: "b".repeat(64), craft_digest: "c".repeat(64) } } });
    assert.equal(fabricated.error, "DENIED");
    const qa = runnerRevision(studio, 1);
    const revisionInput = { program_id: item.program, piece_id: piece.id, revision: { version: "v001", body: qa.body, source_index_digest: qa.source_index_digest, qa: { run_id: qa.run_id } } };
    const revision: any = studio.callTool("piece_revise", revisionInput);
    assert.equal(revision.ok, true);
    assert.equal(revision.result.qa_rerun, true);
    const retry: any = studio.callTool("piece_revise", revisionInput);
    assert.equal(retry.ok, true);
    assert.equal(retry.result.duplicate, true);
    const draftReceipt = linear.apply(revision.result.change_set);
    assert.equal(studio.callTool("linear_sync_reconcile", { program_id: item.program, receipt: draftReceipt }).ok, true);
    assert.equal(linear.counts().documents, 2, "plan document plus one stable piece review document");
    const sameDraft = linear.apply(revision.result.change_set);
    assert.deepEqual(sameDraft, draftReceipt);
  } finally { await studio.close(); }
});

test("recordRevision rejects QA runs with mismatched snapshots, drafts, and tampered receipts", async () => {
  const studio = service("linear-qa-integrity-tenant");
  try {
    const item = plan(studio, "linear-qa-integrity", 3);
    const pending: any = studio.callTool("program_plan_submit_for_approval", { program_id: item.program });
    studio.ownerDecide("approve", pending.result.request_id, pending.result.digest, verifier.assertion());

    const snapshotMismatch = runnerRevision(studio, 1);
    const snapshotResult: any = studio.callTool("piece_revise", { program_id: item.program, piece_id: item.saved.pieces[0].id, revision: { version: "v002", body: snapshotMismatch.body + " Snapshot mismatch.", source_index_digest: snapshotMismatch.source_index_digest, qa: { run_id: snapshotMismatch.run_id } } });
    assert.equal(snapshotResult.error, "DENIED");

    const bodyMismatch = runnerRevision(studio, 1);
    const bodyResult: any = studio.callTool("piece_revise", { program_id: item.program, piece_id: item.saved.pieces[1].id, revision: { version: "v001", body: bodyMismatch.body + " Body mismatch.", source_index_digest: bodyMismatch.source_index_digest, qa: { run_id: bodyMismatch.run_id } } });
    assert.equal(bodyResult.error, "DENIED");

    const tampered = runnerRevision(studio, 1);
    const factualQa = join(tampered.artifact_dir, "factual-qa-v001.json");
    writeFileSync(factualQa, readFileSync(factualQa, "utf8") + "\n");
    const tamperedResult: any = studio.callTool("piece_revise", { program_id: item.program, piece_id: item.saved.pieces[2].id, revision: { version: "v001", body: tampered.body, source_index_digest: tampered.source_index_digest, qa: { run_id: tampered.run_id } } });
    assert.equal(tamperedResult.error, "DENIED");
  } finally { await studio.close(); }
});

test("stale Linear writes conflict, fresh review reads become revision input, and QA is invalidated until rerun", async () => {
  const studio = service("linear-review-tenant");
  const linear = new FakeLinearAdapter();
  try {
    const item = plan(studio, "linear-review", 2);
    const planReceipt = linear.apply(item.saved.change_set);
    studio.callTool("linear_sync_reconcile", { program_id: item.program, receipt: planReceipt });
    const pending: any = studio.callTool("program_plan_submit_for_approval", { program_id: item.program });
    studio.ownerDecide("approve", pending.result.request_id, pending.result.digest, verifier.assertion());
    const pieceId = item.saved.pieces[0].id;
    const firstQa = runnerRevision(studio, 1);
    const first: any = studio.callTool("piece_revise", { program_id: item.program, piece_id: pieceId, revision: { version: "v001", body: firstQa.body, source_index_digest: firstQa.source_index_digest, qa: { run_id: firstQa.run_id } } });
    assert.equal(first.ok, true);
    const reusedQa = runnerRevision(studio, 1);
    const reusedBody = reusedQa.body + "\n\nA distinct valid reused-version draft body.";
    const reusedSnapshotPath = join(reusedQa.artifact_dir, "run-snapshot.json");
    const reusedSnapshot = JSON.parse(readFileSync(reusedSnapshotPath, "utf8"));
    writeFileSync(join(reusedQa.artifact_dir, "draft-v001.md"), reusedBody);
    reusedSnapshot.current_digest = hash(reusedBody);
    writeFileSync(reusedSnapshotPath, JSON.stringify(reusedSnapshot, null, 2));
    assert.equal(studio.callTool("piece_revise", { program_id: item.program, piece_id: pieceId, revision: { version: "v001", body: reusedBody, source_index_digest: reusedQa.source_index_digest, qa: { run_id: reusedQa.run_id } } }).error, "DENIED", "immutable versions cannot be reused after QA passes");
    const firstReceipt = linear.apply(first.result.change_set);
    studio.callTool("linear_sync_reconcile", { program_id: item.program, receipt: firstReceipt });
    const clientKey = first.result.change_set.operations[0].client_key;
    const queuedQa = runnerRevision(studio, 2);
    const queuedUpdate: any = studio.callTool("piece_revise", { program_id: item.program, piece_id: pieceId, revision: { version: "v002", body: queuedQa.body, source_index_digest: queuedQa.source_index_digest, qa: { run_id: queuedQa.run_id } } });
    linear.editDocument(clientKey, "Owner edit with a new useful sentence.");
    const conflict = linear.apply(queuedUpdate.result.change_set);
    assert.equal(conflict.status, "conflict");
    assert.equal((studio.callTool("linear_sync_reconcile", { program_id: item.program, receipt: conflict }).result as any).status, "conflict");
    const comment = linear.addComment(clientKey, "Please make the opening more concrete.");
    const read = linear.readDocument(clientKey);
    const comments = linear.listComments(clientKey);
    const ingested: any = studio.callTool("piece_review_ingest", { program_id: item.program, piece_id: pieceId, document_id: read.document_id, external_revision: read.external_revision, body: read.body, comments });
    assert.equal(ingested.result.status, "captured");
    assert.equal(ingested.result.qa_required, true);
    assert.equal((studio.callTool("piece_status", { program_id: item.program, piece_id: pieceId }).result as any).current_revision.qa_digest, null);
    assert.equal((studio.callTool("piece_review_ingest", { program_id: item.program, piece_id: pieceId, document_id: read.document_id, external_revision: read.external_revision, body: read.body, comments }).result as any).status, "duplicate");
    assert.equal(studio.callTool("piece_review_ingest", { program_id: item.program, piece_id: pieceId, document_id: read.document_id, external_revision: "r1", body: "old", comments: [] }).error, "DENIED");
    assert.equal(studio.callTool("piece_review_ingest", { program_id: item.program, piece_id: pieceId, document_id: read.document_id, external_revision: "opaque-old-read", body: read.body, comments: [] }).error, "DENIED");
    assert.equal(studio.callTool("piece_review_ingest", { program_id: item.program, piece_id: pieceId, document_id: "lin-wrong-document", external_revision: "r3", body: read.body, comments: [] }).error, "DENIED");
    const revisedQa = runnerRevision(studio, 4);
    const revised: any = studio.callTool("piece_revise", { program_id: item.program, piece_id: pieceId, revision: { version: "v004", body: revisedQa.body, source_index_digest: revisedQa.source_index_digest, revision_input_id: ingested.result.revision_input_id, qa: { run_id: revisedQa.run_id } } });
    assert.equal(revised.ok, true);
    assert.equal(revised.result.qa_rerun, true);
    assert.equal(revised.result.change_set.preconditions.external_revisions[clientKey], read.external_revision);
    assert.equal(comment.comment_id, comments[0].comment_id);
    const stored = JSON.parse(readFileSync(join(studio.tenantDir, "programs", `${item.program}.json`), "utf8"));
    assert.equal(stored.revision_inputs[0].body_trust, "untrusted-external");
    assert.equal(stored.revision_inputs[0].comments[0].trust, "untrusted-external");
  } finally { await studio.close(); }
});

test("first Linear review ingest rejects opaque revisions without a prior document revision", async () => {
  const studio = service("linear-opaque-first-ingest-tenant");
  try {
    const item = plan(studio, "linear-opaque-first-ingest", 2);
    const programPath = join(studio.tenantDir, "programs", `${item.program}.json`);
    const stored = JSON.parse(readFileSync(programPath, "utf8"));
    stored.pieces[0].linear.draft_document_id = "lin-first-review-document";
    writeFileSync(programPath, JSON.stringify(stored, null, 2));
    const result: any = studio.callTool("piece_review_ingest", { program_id: item.program, piece_id: item.saved.pieces[0].id, document_id: "lin-first-review-document", external_revision: "opaque-first-read", body: "A first external review body.", comments: [] });
    assert.equal(result.error, "DENIED");
  } finally { await studio.close(); }
});

test("comment-only review accepts the current revision and new comments are not replayed as duplicates", async () => {
  const studio = service("linear-comment-only-tenant");
  const linear = new FakeLinearAdapter();
  try {
    const item = plan(studio, "linear-comment-only", 2);
    studio.callTool("linear_sync_reconcile", { program_id: item.program, receipt: linear.apply(item.saved.change_set) });
    const pending: any = studio.callTool("program_plan_submit_for_approval", { program_id: item.program });
    studio.ownerDecide("approve", pending.result.request_id, pending.result.digest, verifier.assertion());
    const pieceId = item.saved.pieces[0].id, qa = runnerRevision(studio, 1);
    const draft: any = studio.callTool("piece_revise", { program_id: item.program, piece_id: pieceId, revision: { version: "v001", body: qa.body, source_index_digest: qa.source_index_digest, qa: { run_id: qa.run_id } } });
    studio.callTool("linear_sync_reconcile", { program_id: item.program, receipt: linear.apply(draft.result.change_set) });
    const clientKey = draft.result.change_set.operations[0].client_key;
    const firstComment = linear.addComment(clientKey, "Please make the opening more concrete.");
    const read = linear.readDocument(clientKey);
    const first: any = studio.callTool("piece_review_ingest", { program_id: item.program, piece_id: pieceId, document_id: read.document_id, external_revision: read.external_revision, body: read.body, comments: [firstComment] });
    assert.equal(first.result.status, "captured");
    const editedComment = { ...firstComment, body: "Please make the opening substantially more concrete.", updated_at: "2099-01-01T00:00:00.000Z" };
    const edited: any = studio.callTool("piece_review_ingest", { program_id: item.program, piece_id: pieceId, document_id: read.document_id, external_revision: read.external_revision, body: read.body, comments: [editedComment] });
    assert.equal(edited.result.status, "captured");
    assert.notEqual(edited.result.revision_input_id, first.result.revision_input_id);
    const secondComment = linear.addComment(clientKey, "Also shorten the final paragraph.");
    const second: any = studio.callTool("piece_review_ingest", { program_id: item.program, piece_id: pieceId, document_id: read.document_id, external_revision: read.external_revision, body: read.body, comments: [firstComment, secondComment] });
    assert.equal(second.result.status, "captured");
    assert.notEqual(second.result.revision_input_id, first.result.revision_input_id);
    assert.equal((studio.callTool("piece_review_ingest", { program_id: item.program, piece_id: pieceId, document_id: read.document_id, external_revision: read.external_revision, body: read.body, comments: [firstComment, secondComment] }).result as any).status, "duplicate");
  } finally { await studio.close(); }
});

test("video revisions preserve manifest/digest/link metadata while the text Runner refuses execution", async () => {
  const studio = service("linear-video-tenant");
  try {
    assert.equal(studio.callTool("session_start", { idea: "A video-shaped series remains tracked but not produced", slug: "video-review" }).ok, true);
    const evidence: any = studio.callTool("evidence_add_catalog", { session: "video-review", catalog_id: "guide" });
    const proposal: any = studio.callTool("work_shape_propose", { session: "video-review", ...shape(2, ["video"]) });
    const program: any = studio.callTool("program_shape_confirm", { shape_id: proposal.result.shape_id });
    const saved: any = studio.callTool("program_plan_save", { program_id: program.result.program_id, pieces: planned(evidence.result.path, 2, "video") });
    const unapproved: any = studio.callTool("piece_revise", { program_id: program.result.program_id, piece_id: saved.result.pieces[0].id, revision: { version: "v001", source_index_digest: "a".repeat(64), manifest: { scenes: 3 }, binary_digest: "b".repeat(64), review_link: "https://example.invalid/video" } });
    assert.equal(unapproved.error, "DENIED", "revisions require an approved plan");
    const pending: any = studio.callTool("program_plan_submit_for_approval", { program_id: program.result.program_id });
    studio.ownerDecide("approve", pending.result.request_id, pending.result.digest, verifier.assertion());
    assert.equal(studio.callTool("piece_draft_start", { program_id: program.result.program_id, piece_id: saved.result.pieces[0].id, direction: "Draft the video piece", source_refs: [evidence.result.path] }).error, "DENIED", "approved still-planned video pieces are not text Runner inputs");
    const result: any = studio.callTool("piece_revise", { program_id: program.result.program_id, piece_id: saved.result.pieces[0].id, revision: { version: "v001", source_index_digest: "a".repeat(64), manifest: { scenes: 3 }, binary_digest: "b".repeat(64), review_link: "https://example.invalid/video" } });
    assert.equal(result.ok, true);
    assert.equal(result.result.change_set.operations[0].fields.body.binary_digest, "b".repeat(64));
    const retry: any = studio.callTool("piece_revise", { program_id: program.result.program_id, piece_id: saved.result.pieces[0].id, revision: { version: "v001", source_index_digest: "a".repeat(64), manifest: { scenes: 3 }, binary_digest: "b".repeat(64), review_link: "https://example.invalid/video" } });
    assert.equal(retry.ok, true);
    assert.equal(retry.result.duplicate, true);
    assert.equal(studio.callTool("piece_revise", { program_id: program.result.program_id, piece_id: saved.result.pieces[0].id, revision: { version: "v001", source_index_digest: "a".repeat(64), manifest: { scenes: 4 }, binary_digest: "b".repeat(64), review_link: "https://example.invalid/video" } }).error, "DENIED", "immutable video versions cannot be reused");
    assert.equal(studio.callTool("piece_draft_start", { program_id: program.result.program_id, piece_id: saved.result.pieces[0].id, direction: "Draft the video piece", source_refs: [evidence.result.path] }).error, "DENIED");
  } finally { await studio.close(); }
});

test("Linear boundary rejects credential-bearing receipts and keeps source prose out of change sets", async () => {
  const studio = service("linear-boundary-tenant");
  try {
    const item = plan(studio, "linear-boundary", 2);
    assert.ok(!JSON.stringify(item.saved.change_set).includes("Synthetic service context"));
    const receipts = new FakeReceiptStore();
    const valid = { schema_version: "studio.linear-receipt/0.1" as const, operation_id: item.saved.change_set.operation_id, idempotency_key: item.saved.change_set.idempotency_key, status: "pending" as const, objects: [] };
    assert.doesNotThrow(() => receipts.put(valid));
    assert.throws(() => receipts.put({ ...valid, connector_token: "do-not-store" } as any), /Invalid Linear boundary value/);
    assert.equal(studio.callTool("linear_sync_reconcile", { program_id: item.program, receipt: { ...valid, connector_token: "do-not-store" } }).error, "INVALID_REQUEST");
  } finally { await studio.close(); }
});

test("pre-existing restricted or hash-mismatched evidence cannot enter a saved plan", async () => {
  const studio = service("program-evidence-integrity-tenant");
  try {
    const restricted = prepare(studio, "restricted-existing");
    const restrictedSession = JSON.parse(readFileSync(join(studio.workspace, "sessions", "restricted-existing", "session.json"), "utf8"));
    restrictedSession.evidence[0].visibility = "restricted";
    writeFileSync(join(studio.workspace, "sessions", "restricted-existing", "session.json"), JSON.stringify(restrictedSession));
    assert.equal(studio.callTool("program_plan_save", { program_id: restricted.program, pieces: planned(restricted.evidence) }).error, "INVALID_REQUEST");

    const tampered = prepare(studio, "hash-mismatched");
    writeFileSync(join(studio.workspace, tampered.evidence), "Tampered synthetic evidence");
    assert.equal(studio.callTool("program_plan_save", { program_id: tampered.program, pieces: planned(tampered.evidence) }).error, "INVALID_REQUEST");
  } finally { await studio.close(); }
});
