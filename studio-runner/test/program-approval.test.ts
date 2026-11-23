/**
 * Series PR 3: review policies, exact final, QA verdict gate, publish-gate contract and the fake-host first run.
 * Every refusal has a positive control, and each guard has a test that fails when the guard is removed (see the PR body).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudioService } from "../src/service/studio-service.ts";
import { AuthorityStore } from "../src/service/authority-store.ts";
import { hash } from "../src/runner.ts";
import { TestOwnerVerifier } from "./helpers/test-owner-verifier.ts";
import { sourceWorkspace } from "./helpers/service-fixture.ts";
import { DRAFT, Flow, LINEAR_ACCOUNT, failingModel, type QaFailure } from "./helpers/program-flow.ts";

const verifier = new TestOwnerVerifier();
const open = (tenantId: string, extra: Record<string, unknown> = {}, dataRoot = mkdtempSync(join(tmpdir(), "studio-approval-data-"))) =>
  new StudioService({ dataRoot, tenantId, workspace: sourceWorkspace(), ownerVerifier: verifier, ...extra });
const linearTenant = (tenantId: string) => open(tenantId, { reviewPolicy: "linear-review", linearAccountId: LINEAR_ACCOUNT });
const DEST = "newsletter:primary";

function approvePlanWithPasskey(flow: Flow) {
  const pending = flow.call("program_plan_submit_for_approval", { program_id: flow.program });
  assert.equal(pending.ok, true);
  flow.studio.ownerDecide("approve", pending.result.request_id, pending.result.digest, verifier.assertion());
  assert.equal(flow.call("program_plan_status", { program_id: flow.program }).result.approved, true);
}
const planMarker = (flow: Flow, body = `/studio approve-plan ${flow.program}`, account = LINEAR_ACCOUNT) =>
  ({ program_id: flow.program, document: flow.linear.readDocument(flow.planKey()), comment: flow.marker(flow.planKey(), body, account) });
function approvePlanWithMarker(flow: Flow) {
  const submitted = flow.call("program_plan_submit_for_approval", { program_id: flow.program });
  assert.equal(submitted.result.status, "awaiting_linear_marker");
  assert.equal(flow.call("linear_review_marker", planMarker(flow)).ok, true);
  assert.equal(flow.call("program_plan_status", { program_id: flow.program }).result.approved, true);
}
const finalRequest = (flow: Flow, pieceId: string, document: unknown = flow.document(pieceId)) => flow.call("piece_final_request", { program_id: flow.program, piece_id: pieceId, document });
const pieceMarker = (flow: Flow, pieceId: string, body = `/studio final ${pieceId}`, account = LINEAR_ACCOUNT) =>
  ({ program_id: flow.program, piece_id: pieceId, document: flow.read(pieceId), comment: flow.marker(flow.draftKey(pieceId), body, account) });
const isFinal = (flow: Flow, pieceId: string) => flow.status(pieceId).status === "final";
const authorityEntries = (studio: StudioService) => { const store = new AuthorityStore(studio.tenantDir); try { return store.size(); } finally { store.close(); } };

/** A passkey tenant with plan 1 approved and piece 1 drafted, QA-clean and synced to the fake Linear. */
function reviewedPasskey(tenantId: string, count = 2) {
  const flow = new Flow(open(tenantId)).plan(tenantId + "-s", count);
  approvePlanWithPasskey(flow);
  flow.draftPiece(flow.pieces[0].id);
  return flow;
}
function reviewedLinear(tenantId: string, count = 2) {
  const flow = new Flow(linearTenant(tenantId)).plan(tenantId + "-s", count);
  approvePlanWithMarker(flow);
  flow.draftPiece(flow.pieces[0].id);
  return flow;
}
async function decideFinal(flow: Flow, requestId: string, digest: string) {
  flow.studio.ownerDecide("approve", requestId, digest, verifier.assertion());
}

test("review_policy is tenant-owned, defaults to passkey, cannot be flipped on restart, and only linear-review tenants expose the marker tool", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "studio-policy-data-"));
  const passkey = open("policy-default", {}, dataRoot);
  const linear = linearTenant("policy-linear");
  try {
    assert.equal(JSON.parse(readFileSync(join(passkey.tenantDir, "tenant.json"), "utf8")).review_policy, undefined, "unset means passkey");
    assert.ok(!passkey.listTools().some((tool) => tool.name === "linear_review_marker"), "passkey tenants expose no model-callable approval path");
    assert.equal(passkey.callTool("linear_review_marker", { program_id: "program-" + "0".repeat(16), document: {}, comment: {} }).error, "DENIED");
    assert.ok(linear.listTools().some((tool) => tool.name === "linear_review_marker"));
    const record = JSON.parse(readFileSync(join(linear.tenantDir, "tenant.json"), "utf8"));
    assert.deepEqual([record.review_policy, record.linear_account_id], ["linear-review", LINEAR_ACCOUNT]);
    assert.throws(() => open("policy-bad", { reviewPolicy: "nonsense" }), /Invalid tenant review policy/);
    assert.throws(() => open("policy-unknown-account", { reviewPolicy: "nonsense", linearAccountId: LINEAR_ACCOUNT }), /Invalid tenant review policy/);
    assert.throws(() => open("policy-no-account", { reviewPolicy: "linear-review" }), /Invalid tenant review policy/);
    assert.throws(() => open("policy-stray-account", { linearAccountId: LINEAR_ACCOUNT }), /Invalid tenant review policy/);
    await passkey.close();
    assert.throws(() => open("policy-default", { reviewPolicy: "linear-review", linearAccountId: LINEAR_ACCOUNT }, dataRoot), /conflict with the review policy fixed/, "a conflicting restart flag is refused, not silently ignored");
    const reopened = open("policy-default", {}, dataRoot);
    assert.ok(!reopened.listTools().some((tool) => tool.name === "linear_review_marker"), "the stored tenant policy still applies on a plain restart");
    await reopened.close();
  } finally { await linear.close(); }
});

test("plan approval binds the Linear plan revision: syncing after approval stales it, and a pending request is not reused across revisions", async () => {
  const flow = new Flow(open("plan-revision")).plan("plan-revision-s", 2, false);
  try {
    const early: any = flow.call("program_plan_submit_for_approval", { program_id: flow.program });
    flow.syncPlan(flow.changeSet);
    const later: any = flow.call("program_plan_submit_for_approval", { program_id: flow.program });
    assert.notEqual(later.result.request_id, early.result.request_id, "a request for an unsynced plan is not the request for the synced plan");
    flow.studio.ownerDecide("approve", early.result.request_id, early.result.digest, verifier.assertion());
    assert.equal(flow.call("program_plan_status", { program_id: flow.program }).result.approved, false, "approval of the unsynced plan does not cover the plan the owner now sees in Linear");
    const input = { program_id: flow.program, piece_id: flow.pieces[0].id, direction: "Draft the first piece from the agreed angle", source_refs: [flow.evidence] };
    assert.equal(flow.call("linear_review_marker", planMarker(flow)).error, "DENIED", "a passkey tenant ignores a perfectly formed Linear marker");
    const { author: _author, ...authorless } = planMarker(flow).comment as Record<string, unknown>;
    assert.equal(flow.call("linear_review_marker", { ...planMarker(flow), comment: authorless }).error, "DENIED", "no review account on the tenant and no author on the comment must not compare equal");
    assert.equal(flow.call("program_plan_status", { program_id: flow.program }).result.approved, false);
    assert.equal(flow.call("piece_draft_start", input).error, "DENIED");
    flow.studio.ownerDecide("approve", later.result.request_id, later.result.digest, verifier.assertion());
    assert.equal(flow.call("piece_draft_start", input).ok, true, "positive control: approving the synced revision opens piece 1");
  } finally { await flow.studio.close(); }
});

test("passkey final: only the owner channel finalizes the exact shown version; pending, forged, wrong-digest and bad-document paths stay non-final", async () => {
  const flow = reviewedPasskey("passkey-final");
  const piece = flow.pieces[0].id;
  try {
    const document = flow.document(piece);
    for (const bad of [{ ...document, external_revision: "r99" }, { ...document, body: document.body + " edited" }, { ...document, document_id: "lin-other-document" }, {}])
      assert.equal(finalRequest(flow, piece, bad).error, "DENIED", String(JSON.stringify(bad)).slice(0, 60));
    const before = authorityEntries(flow.studio);
    const request = finalRequest(flow, piece);
    assert.equal(request.ok, true);
    assert.equal(request.result.status, "pending");
    assert.equal(finalRequest(flow, piece).result.request_id, request.result.request_id, "the same exact version reuses its pending request");
    assert.notEqual(flow.status(piece).status, "final", "a pending request grants nothing");
    assert.equal(authorityEntries(flow.studio), before + 1, "only the pending snapshot was written");

    // A forged program file cannot create finality.
    const file = join(flow.studio.tenantDir, "programs", `${flow.program}.json`), stored = JSON.parse(readFileSync(file, "utf8"));
    stored.pieces[0].status = "final";
    stored.pieces[0].final = { version: stored.pieces[0].current_revision.version, digest: stored.pieces[0].current_revision.digest, policy: "passkey", authenticated: true, recorded_at: "now", receipt_ref: "forged" };
    writeFileSync(file, JSON.stringify(stored));
    assert.equal(flow.status(piece).status, "in_review");
    assert.equal(flow.status(piece).final, null);

    assert.throws(() => flow.studio.ownerDecide("approve", request.result.request_id, hash("another digest"), verifier.assertion()), /changed since it was shown/);
    assert.throws(() => flow.studio.ownerDecide("approve", request.result.request_id, request.result.digest, { verifier: "test-only", subject: "someone-else", proof: "x" }), /rejected/);
    assert.notEqual(flow.status(piece).status, "final");

    await decideFinal(flow, request.result.request_id, request.result.digest);
    const status = flow.status(piece);
    assert.equal(status.status, "final");
    assert.deepEqual([status.final.policy, status.final.authenticated, status.final.version, status.final.digest], ["passkey", true, status.current_revision.version, status.current_revision.digest]);
    assert.match(status.final.receipt_ref, /^pending-/);
    assert.throws(() => flow.studio.ownerDecide("approve", request.result.request_id, request.result.digest, verifier.assertion()), /already decided|unavailable/, "a decision is consumed once");
  } finally { await flow.studio.close(); }
});

test("a passkey request is bound to the version it showed: a newer revision, an owner edit or a rejection never finalizes it", async () => {
  const flow = reviewedPasskey("passkey-stale");
  const piece = flow.pieces[0].id;
  try {
    const stale: any = finalRequest(flow, piece);
    // A newer reviewed revision exists while the old request is still pending: the old digest no longer describes the piece.
    const input = flow.ingestOwnerEdit(piece, DRAFT + "\n\nAn owner-added sentence about the sticker test.");
    assert.throws(() => flow.studio.ownerDecide("approve", stale.result.request_id, stale.result.digest, verifier.assertion()), /not ready|changed/, "owner edit before re-review");
    flow.reviseFromEdit(piece, input);
    assert.throws(() => flow.studio.ownerDecide("approve", stale.result.request_id, stale.result.digest, verifier.assertion()), /changed since the request was made/);
    assert.notEqual(flow.status(piece).status, "final");
    // Positive control, then a rejected request and an edit after final.
    const fresh: any = finalRequest(flow, piece);
    assert.notEqual(fresh.result.digest, stale.result.digest);
    flow.studio.ownerDecide("reject", fresh.result.request_id, fresh.result.digest, verifier.assertion());
    assert.notEqual(flow.status(piece).status, "final", "reject leaves the piece non-final");
    const again: any = finalRequest(flow, piece);
    await decideFinal(flow, again.result.request_id, again.result.digest);
    assert.equal(isFinal(flow, piece), true);
    flow.ingestOwnerEdit(piece, DRAFT + "\n\nA later edit.", "One more thing.");
    assert.equal(isFinal(flow, piece), false, "any later Linear edit or comment reopens the piece");
    assert.equal(finalRequest(flow, piece).error, "DENIED", "and it needs fresh QA before it can be finalized again");
  } finally { await flow.studio.close(); }
});

test("mark_final reads the verdicts inside the QA artifacts and re-verifies the QA digest at final time", async () => {
  const failures: QaFailure[] = ["unsupported", "unchecked", "unlisted", "craft-revise", "craft-must"];
  const flow = new Flow(open("qa-verdicts")).plan("qa-verdicts-s", failures.length + 2);
  try {
    approvePlanWithPasskey(flow);
    const ids = flow.pieces.map((piece) => piece.id), tampered = ids[failures.length], clean = ids[failures.length + 1];
    failures.forEach((failure, index) => flow.draftPiece(ids[index], 1, failingModel(failure)));
    const tamperedRun = flow.draftPiece(tampered);
    flow.draftPiece(clean);
    failures.forEach((failure, index) => {
      assert.equal(flow.status(ids[index]).status, "in_review", `${failure}: a blocked revision is still reviewable in Linear`);
      assert.ok(flow.status(ids[index]).current_revision.qa_digest, `${failure}: the QA digest exists, so only the verdict can stop it`);
      assert.equal(finalRequest(flow, ids[index]).error, "DENIED", `${failure} blocks finality`);
    });
    assert.equal(finalRequest(flow, tampered).ok, true, "positive control before tampering");
    const factual = join(tamperedRun.artifact_dir, `factual-qa-${tamperedRun.version}.json`);
    writeFileSync(factual, readFileSync(factual, "utf8") + "\n");
    assert.equal(finalRequest(flow, tampered).error, "DENIED", "QA artifacts changed after the revision was recorded");
    assert.equal(finalRequest(flow, clean).ok, true, "a clean QA run is finalizable");
  } finally { await flow.studio.close(); }
});

test("linear-review plan approval: only the agreed marker from the review account on the current plan revision approves, as authenticated:false", async () => {
  const flow = new Flow(linearTenant("lr-plan")).plan("lr-plan-s", 2);
  try {
    const submitted: any = flow.call("program_plan_submit_for_approval", { program_id: flow.program });
    assert.deepEqual([submitted.result.status, submitted.result.marker], ["awaiting_linear_marker", `/studio approve-plan ${flow.program}`]);
    assert.equal(flow.studio.pendingRequests().length, 0, "linear-review tenants are not offered the passkey path");
    const approved = () => flow.call("program_plan_status", { program_id: flow.program }).result.approved;
    const attempt = (input: Record<string, unknown>) => flow.call("linear_review_marker", input);
    const good = planMarker(flow, "an ordinary comment that says approved");
    assert.equal(attempt(good).error, "DENIED", "ordinary comment");
    assert.equal(attempt(planMarker(flow, `/studio approve-plan program-${"0".repeat(16)}`)).error, "DENIED", "marker for another program");
    assert.equal(attempt(planMarker(flow, undefined, "someone-else")).error, "DENIED", "wrong account");
    const fresh = planMarker(flow);
    assert.equal(attempt({ ...fresh, document: { ...fresh.document, updated_at: new Date(Date.now() + 60_000).toISOString() } }).error, "DENIED", "marker older than the document's latest edit");
    assert.equal(attempt({ ...fresh, document: { ...fresh.document, external_revision: "r9" } }).error, "DENIED", "not the current plan revision");
    assert.equal(attempt({ ...fresh, document: { ...fresh.document, document_id: "lin-other" } }).error, "DENIED", "comment and read disagree");
    assert.equal(attempt({ ...fresh, document: { ...fresh.document, document_id: "lin-other" }, comment: { ...fresh.comment, document_id: "lin-other" } }).error, "DENIED", "a consistent read of a document that is not the plan");
    assert.equal(attempt({ ...fresh, issue_status: "Done" }).error, "INVALID_REQUEST", "issue status is not a marker");
    assert.equal(approved(), false);
    assert.equal(attempt(fresh).ok, true, "positive control: the exact marker approves");
    assert.equal(approved(), true);
    const record = new AuthorityStore(flow.studio.tenantDir);
    try {
      const entry = record.latest("plan_approval", "program-plan-" + flow.program)!;
      assert.deepEqual([entry.policy, entry.authenticated, entry.identity_assurance], ["linear-review", false, "linear-account-session"]);
    } finally { record.close(); }
    assert.equal(attempt(fresh).error, "DENIED", "a replayed marker is refused once approved");
  } finally { await flow.studio.close(); }
});

test("linear-review final: the explicit marker on the current revision finalizes as authenticated:false; comments, status, stale and replayed markers do not", async () => {
  const flow = reviewedLinear("lr-final");
  const [piece, other] = flow.pieces.map((entry) => entry.id);
  try {
    const request: any = finalRequest(flow, piece);
    assert.deepEqual([request.result.status, request.result.marker], ["awaiting_linear_marker", `/studio final ${piece}`]);
    assert.equal(flow.studio.pendingRequests().length, 0);
    const attempt = (input: Record<string, unknown>) => flow.call("linear_review_marker", input);
    assert.equal(attempt(pieceMarker(flow, piece, "Looks great, approved and final!")).error, "DENIED", "ordinary comment");
    assert.equal(attempt(pieceMarker(flow, piece, `/studio final ${other}`)).error, "DENIED", "marker for another piece");
    assert.equal(attempt(pieceMarker(flow, piece, undefined, "someone-else")).error, "DENIED", "wrong account");
    const fresh = pieceMarker(flow, piece);
    assert.equal(attempt({ ...fresh, document: { ...fresh.document, updated_at: new Date(Date.now() + 60_000).toISOString() } }).error, "DENIED", "marker predates the latest edit");
    assert.equal(attempt({ ...fresh, issue_status: "Done" }).error, "INVALID_REQUEST", "issue status alone is not a marker");
    assert.equal(attempt({ ...fresh, comment: { ...fresh.comment, status: "Done" } }).error, "DENIED", "unknown comment fields are refused");
    assert.equal(attempt({ ...fresh, document: { ...fresh.document, issue_status: "Done" } }).error, "DENIED", "unknown document fields are refused");
    assert.equal(attempt({ program_id: flow.program, piece_id: piece, document: flow.read(piece), comment: { ...fresh.comment, document_id: "lin-other" } }).error, "DENIED", "comment on another document");
    assert.equal(isFinal(flow, piece), false);

    // A marker posted, then the owner edits the document: the old marker does not cover the new revision.
    flow.linear.editDocument(flow.draftKey(piece), DRAFT + "\n\nA sentence added after the marker.");
    assert.equal(attempt({ ...fresh, document: flow.read(piece) }).error, "DENIED", "stale marker after an edit");
    flow.reviseFromEdit(piece, flow.ingestOwnerEdit(piece, DRAFT + "\n\nA second owner edit."));
    assert.equal(attempt(fresh).error, "DENIED", "the old marker is stale for the re-reviewed revision");

    const current = pieceMarker(flow, piece);
    const done: any = attempt(current);
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.deepEqual([done.result.authenticated, done.result.publish_eligible], [false, false]);
    const status = flow.status(piece);
    assert.deepEqual([status.status, status.final.policy, status.final.authenticated], ["final", "linear-review", false]);
    assert.equal(attempt(current).error, "DENIED", "a replayed marker is refused once final");
    flow.ingestOwnerEdit(piece, DRAFT + "\n\nAfter final.");
    assert.equal(isFinal(flow, piece), false, "an edit after the marker reopens the piece");
  } finally { await flow.studio.close(); }
});

test("publish gate contract: only a current passkey final plus a separate destination authorization passes; linear-review, draft and stale finals are rejected", async () => {
  const flow = reviewedPasskey("publish-gate");
  const piece = flow.pieces[0].id, linearFlow = reviewedLinear("publish-gate-lr");
  try {
    const request: any = finalRequest(flow, piece);
    const gate = (over: Record<string, unknown> = {}) => {
      const status = flow.status(piece);
      return flow.studio.publishGate(flow.program, piece, { destination: DEST, digest: status.current_revision.digest, document_revision: status.linear.document_revision, ...over } as any);
    };
    const authorize = (over: Record<string, unknown> = {}) => flow.studio.ownerChannelForTesting().decide("publish_authorization", "publish-" + piece, { program_id: flow.program, piece_id: piece, final_digest: flow.status(piece).current_revision.digest, destination: DEST, ...over }, verifier.assertion());

    authorize();
    assert.equal(gate().allowed, false, "a destination authorization without a final is not enough (draft only)");
    await decideFinal(flow, request.result.request_id, request.result.digest);
    assert.equal(gate().allowed, true, "positive control: passkey final + separate authorization");
    assert.equal(gate({ destination: "newsletter:other" }).allowed, false, "another destination");
    assert.equal(gate({ digest: hash("changed asset") }).allowed, false, "changed asset");
    assert.equal(gate({ document_revision: "r99" }).allowed, false, "stale document revision");
    assert.equal(gate({ destination: "" }).allowed, false);
    authorize({ destination: "newsletter:other" });
    assert.equal(gate().allowed, false, "the latest authorization names another destination");
    authorize({ final_digest: hash("an earlier digest") });
    assert.equal(gate().allowed, false, "authorization for a different final");
    authorize();
    assert.equal(gate().allowed, true);
    const exact = { destination: DEST, digest: flow.status(piece).final.digest, document_revision: flow.status(piece).linear.document_revision };
    flow.ingestOwnerEdit(piece, DRAFT + "\n\nAn edit after final.");
    assert.equal(flow.studio.publishGate(flow.program, piece, exact).allowed, false, "a publisher holding the old exact values is refused once the piece was edited");

    // linear-review finals never satisfy a publish request, even with an authorization on file.
    const lrPiece = linearFlow.pieces[0].id;
    assert.equal(linearFlow.call("linear_review_marker", pieceMarker(linearFlow, lrPiece)).ok, true);
    const lrStatus = linearFlow.status(lrPiece);
    linearFlow.studio.ownerChannelForTesting().decide("publish_authorization", "publish-" + lrPiece, { program_id: linearFlow.program, piece_id: lrPiece, final_digest: lrStatus.current_revision.digest, destination: DEST }, verifier.assertion());
    const lr = linearFlow.studio.publishGate(linearFlow.program, lrPiece, { destination: DEST, digest: lrStatus.current_revision.digest, document_revision: lrStatus.linear.document_revision });
    assert.equal(lr.allowed, false);
    assert.match(lr.reason, /passkey final/);
  } finally { await flow.studio.close(); await linearFlow.studio.close(); }
});

test("fake-host first run: idea -> shape -> plan in Linear -> plan approval -> draft -> Linear comment/edit -> revision with QA -> final, with approved context only", async () => {
  const flow = new Flow(open("first-run")).plan("first-run-s", 2);
  const [one, two] = flow.pieces.map((entry) => entry.id);
  try {
    assert.deepEqual(flow.linear.counts(), { projects: 1, issues: 2, documents: 1 }, "plan in Linear: one project, an issue per piece, one plan document");
    const direction = (piece: string) => ({ program_id: flow.program, piece_id: piece, direction: "Draft this piece from the agreed angle", source_refs: [flow.evidence] });
    assert.equal(flow.call("piece_draft_start", direction(one)).error, "DENIED", "no drafting before plan approval");
    approvePlanWithPasskey(flow);
    const start: any = flow.call("piece_draft_start", direction(one));
    assert.deepEqual(start.result.prior_approved_context, []);
    assert.match(start.result.note, /run_start.*piece_revise/, "the start note points at the real draft hand-off");
    assert.doesNotMatch(start.result.note, /PR 1/);

    // Draft, then the owner edits and comments in Linear. The first edit introduces an unsupported claim.
    flow.draftPiece(one);
    assert.equal(flow.linear.counts().documents, 2, "plan document plus one stable review document");
    const badEdit = flow.ingestOwnerEdit(one, DRAFT + "\n\nThe pilot cut late returns by 80 percent.", "Add the headline result.");
    flow.reviseFromEdit(one, badEdit, failingModel("unsupported"));
    assert.equal(flow.status(one).status, "in_review");
    assert.equal(finalRequest(flow, one).error, "DENIED", "fact QA blocks the unsupported claim");
    // The corrected edit reaches review again and passes QA.
    const goodEdit = flow.ingestOwnerEdit(one, DRAFT + "\n\nThere is no result yet.", "Remove the unsupported number.");
    flow.reviseFromEdit(one, goodEdit);
    const piece2Early: any = flow.call("piece_draft_start", direction(two));
    assert.deepEqual(piece2Early.result.prior_approved_context, [], "an unapproved piece is not continuity context");

    const request: any = finalRequest(flow, one);
    assert.equal(request.ok, true);
    await decideFinal(flow, request.result.request_id, request.result.digest);
    assert.equal(isFinal(flow, one), true);

    const next: any = flow.call("piece_draft_start", direction(two));
    assert.equal(next.result.prior_approved_context.length, 1);
    assert.deepEqual(next.result.prior_approved_context[0], { piece_id: one, title: "Piece 1", angle: "A distinct safe angle 1", audience_promise: "A useful promise 1", evidence_refs: [flow.evidence], final_digest: flow.status(one).final.digest });
    const body = flow.document(one).body;
    assert.ok(!JSON.stringify(next.result).includes(body.slice(0, 80)), "prior draft text is not passed on");
    assert.ok(!flow.studio.listTools().some((tool) => /publish|schedule|account/.test(tool.name)), "no publish, schedule or account tool exists");
  } finally { await flow.studio.close(); }
});

test("fake-host first run under linear-review reaches an unauthenticated final that is never publish-eligible", async () => {
  const flow = new Flow(linearTenant("first-run-lr")).plan("first-run-lr-s", 2);
  const [one] = flow.pieces.map((entry) => entry.id);
  try {
    approvePlanWithMarker(flow);
    flow.draftPiece(one);
    const input = flow.ingestOwnerEdit(one, DRAFT + "\n\nThere is no result yet.", "Please remove the number.");
    flow.reviseFromEdit(one, input);
    assert.equal(flow.call("linear_review_marker", pieceMarker(flow, one)).ok, true);
    const status = flow.status(one);
    assert.deepEqual([status.status, status.final.authenticated, status.final.policy], ["final", false, "linear-review"]);
    assert.equal(flow.studio.publishGate(flow.program, one, { destination: DEST, digest: status.final.digest, document_revision: status.linear.document_revision }).allowed, false);
  } finally { await flow.studio.close(); }
});

test("a blocked revision cannot borrow another run's clean QA receipts", async () => {
  const flow = new Flow(open("qa-borrowed")).plan("qa-borrowed-s", 2);
  try {
    approvePlanWithPasskey(flow);
    const [blocked, clean] = flow.pieces.map((piece) => piece.id);
    const run = flow.draftPiece(blocked, 1, failingModel("unsupported"));
    flow.draftPiece(clean, Number(run.version.slice(1)));
    const borrowed = flow.status(clean).current_revision.qa_receipt_ids;
    assert.equal(finalRequest(flow, blocked).error, "DENIED");
    // Same version and body, so the clean run's receipts pass every artifact check; only the recorded QA digest differs.
    const file = join(flow.studio.tenantDir, "programs", `${flow.program}.json`), stored = JSON.parse(readFileSync(file, "utf8"));
    const cleanRun = borrowed[0].split(":")[0];
    assert.equal(flow.status(clean).current_revision.version, run.version, "the borrowed run must be the same version for this to isolate the digest check");
    stored.pieces[0].current_revision.qa_receipt_ids = borrowed;
    writeFileSync(file, JSON.stringify(stored));
    assert.equal(finalRequest(flow, blocked).error, "DENIED", `receipts of run ${cleanRun} do not match the QA digest recorded for the blocked revision`);
    assert.equal(finalRequest(flow, clean).ok, true, "positive control");
  } finally { await flow.studio.close(); }
});

test("finality exists only while the signed record matches the exact current revision, QA, document and scope", async () => {
  const flow = reviewedPasskey("final-exactness");
  const piece = flow.pieces[0].id;
  try {
    const request: any = finalRequest(flow, piece);
    await decideFinal(flow, request.result.request_id, request.result.digest);
    assert.equal(isFinal(flow, piece), true);
    const file = join(flow.studio.tenantDir, "programs", `${flow.program}.json`), original = readFileSync(file, "utf8");
    const tamper: [string, (entry: any) => void][] = [
      ["version", (entry) => { entry.current_revision.version = "v099"; }],
      ["asset digest", (entry) => { entry.current_revision.digest = hash("another asset"); }],
      ["QA digest", (entry) => { entry.current_revision.qa_digest = hash("another QA"); }],
      ["Linear document revision", (entry) => { entry.linear.document_revision = "r99"; }],
      ["Linear document", (entry) => { entry.linear.draft_document_id = "lin-other"; }],
    ];
    for (const [name, edit] of tamper) {
      const stored = JSON.parse(original);
      edit(stored.pieces[0]);
      writeFileSync(file, JSON.stringify(stored));
      assert.equal(isFinal(flow, piece), false, name);
      writeFileSync(file, original);
      assert.equal(isFinal(flow, piece), true, "control after " + name);
    }
    // A final recorded for another scope does not count as the private editorial final.
    const store = new AuthorityStore(flow.studio.tenantDir);
    try {
      const record = store.latest("piece_final", "piece-final-" + piece)!;
      const planted: [string, Record<string, unknown>][] = [["destination scope", { ...record, destination: DEST }], ["another program", { ...record, program_id: "program-" + "1".repeat(16) }], ["another piece", { ...record, piece_id: "piece-" + "1".repeat(16) }]];
      for (const [name, forged] of planted) {
        store.write("piece_final", "piece-final-" + piece, forged);
        assert.equal(isFinal(flow, piece), false, name);
        store.write("piece_final", "piece-final-" + piece, record);
        assert.equal(isFinal(flow, piece), true, "control after " + name);
      }
    } finally { store.close(); }
  } finally { await flow.studio.close(); }
});

test("a withdrawn plan approval, or a video piece, cannot be finalized", async () => {
  const flow = reviewedPasskey("final-plan-withdrawn");
  const piece = flow.pieces[0].id;
  const video = new Flow(open("final-video")).plan("final-video-s", 2, true, "video");
  try {
    assert.equal(finalRequest(flow, piece).ok, true, "positive control");
    const status: any = flow.call("program_plan_status", { program_id: flow.program }).result;
    const channel = flow.studio.ownerChannelForTesting();
    channel.decide("plan_approval", "program-plan-" + flow.program, { program_id: flow.program, plan_digest: hash("a different plan") }, verifier.assertion());
    assert.equal(finalRequest(flow, piece).error, "DENIED", "the latest plan decision no longer covers this plan");
    channel.decide("plan_approval", "program-plan-" + flow.program, { program_id: flow.program, plan_digest: status.plan_digest, document_revision: flow.linear.readDocument(flow.planKey()).external_revision }, verifier.assertion());
    assert.equal(finalRequest(flow, piece).ok, true);

    approvePlanWithPasskey(video);
    const videoPiece = video.pieces[0].id;
    const revised = video.call("piece_revise", { program_id: video.program, piece_id: videoPiece, revision: { version: "v001", source_index_digest: "a".repeat(64), manifest: { scenes: 3 }, binary_digest: "b".repeat(64), review_link: "https://example.invalid/video" } });
    assert.equal(revised.ok, true);
    assert.equal(video.call("linear_sync_reconcile", { program_id: video.program, receipt: video.linear.apply(revised.result.change_set) }).ok, true);
    assert.equal(video.status(videoPiece).status, "in_review");
    assert.equal(finalRequest(video, videoPiece).error, "DENIED", "video QA and a binary-aware approval do not exist yet");
  } finally { await flow.studio.close(); await video.studio.close(); }
});

test("publish gate fails closed on forged or malformed final and authorization records", async () => {
  const flow = reviewedPasskey("publish-forged");
  const piece = flow.pieces[0].id;
  try {
    const request: any = finalRequest(flow, piece);
    await decideFinal(flow, request.result.request_id, request.result.digest);
    const status = flow.status(piece);
    const ask = { destination: DEST, digest: status.final.digest, document_revision: status.linear.document_revision };
    const grant = { program_id: flow.program, piece_id: piece, final_digest: status.final.digest, destination: DEST };
    const channel = flow.studio.ownerChannelForTesting();
    assert.match(flow.studio.publishGate(flow.program, piece, ask).reason, /No owner authorization/, "a passkey final alone is not publish authority");
    channel.decide("publish_authorization", "publish-" + piece, grant, verifier.assertion());
    assert.equal(flow.studio.publishGate(flow.program, piece, ask).allowed, true, "positive control");
    const store = new AuthorityStore(flow.studio.tenantDir);
    try {
      const final = store.latest("piece_final", "piece-final-" + piece)!;
      const finals: [string, Record<string, unknown>][] = [["linear-review policy", { ...final, policy: "linear-review" }], ["authenticated false", { ...final, authenticated: false }], ["no owner binding", Object.fromEntries(Object.entries(final).filter(([key]) => key !== "owner_binding"))]];
      for (const [name, record] of finals) {
        store.write("piece_final", "piece-final-" + piece, record);
        assert.equal(flow.studio.publishGate(flow.program, piece, ask).allowed, false, name);
        store.write("piece_final", "piece-final-" + piece, final);
        assert.equal(flow.studio.publishGate(flow.program, piece, ask).allowed, true, "control after " + name);
      }
      const grants: [string, Record<string, unknown>][] = [["no owner subject", grant], ["another program", { ...grant, program_id: "program-" + "1".repeat(16), owner_subject: "test-owner" }], ["another piece", { ...grant, piece_id: "piece-" + "1".repeat(16), owner_subject: "test-owner" }]];
      for (const [name, record] of grants) {
        store.write("publish_authorization", "publish-" + piece, record);
        assert.equal(flow.studio.publishGate(flow.program, piece, ask).allowed, false, name);
      }
    } finally { store.close(); }
    for (const bad of [null, {}, { ...ask, destination: 5 }, { ...ask, digest: undefined }]) assert.equal(flow.studio.publishGate(flow.program, piece, bad as any).allowed, false);
    // An authorization with no destination must not match a request with no destination.
    channel.decide("publish_authorization", "publish-" + piece, { program_id: flow.program, piece_id: piece, final_digest: status.final.digest }, verifier.assertion());
    assert.equal(flow.studio.publishGate(flow.program, piece, { ...ask, destination: undefined } as any).allowed, false);
    assert.equal(flow.studio.publishGate(flow.program, "piece-" + "2".repeat(16), ask).allowed, false, "unknown piece");
  } finally { await flow.studio.close(); }
});
