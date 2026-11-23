import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  StudioService,
  AUTHORITY_TOOL_DENYLIST,
  MAX_HTTP_REQUEST_BYTES,
  tenantModelConfig,
} from "../src/service/studio-service.ts";
import { sessionStart } from "../src/director-session.ts";
import { hash, inspectRun, REPO_ROOT } from "../src/runner.ts";
import { AuthorityStore, sourceSubject } from "../src/service/authority-store.ts";
import { TestOwnerVerifier } from "./helpers/test-owner-verifier.ts";
import { sourceWorkspace } from "./helpers/service-fixture.ts";

const testOwner = new TestOwnerVerifier();

function runInput(session = "service-run") {
  return { session };
}
function legacyRunInput() {
  const request = JSON.parse(
    readFileSync(
      join(REPO_ROOT, "studio-runner/fixtures/agent-sample/request.json"),
      "utf8",
    ),
  );
  return {
    idea: request.idea,
    audience: request.audience,
    source_paths: request.source_paths,
  };
}
function serviceRequest() {
  return {
    schema_version: "studio.request/0.2",
    workspace_id: "riverside-tool-library",
    mode: "one_off",
    ...legacyRunInput(),
    provider: "fixture",
    models: {
      director: "fixture",
      writer: "fixture",
      fact_reviewer: "fixture",
      craft_reviewer: "fixture",
    },
    budget: { max_model_calls: 12, max_steps: 40, max_revision_rounds: 1 },
    permissions: {
      actions: ["read_sources", "write_private_draft", "run_metadata_gate"],
    },
  };
}
function authorizeRun(
  service: StudioService,
  session = "service-run",
  visibility: "approved" | "restricted" = "approved",
) {
  const source = JSON.parse(
    readFileSync(
      join(REPO_ROOT, "studio-runner/fixtures/agent-sample/request.json"),
      "utf8",
    ),
  );
  const assertion = testOwner.assertion();
  const sources = source.source_paths.map((path: string) => {
    const digest = hash(readFileSync(join(service.workspace, path), "utf8"));
    service.ownerChannelForTesting().decide(
      "source_classification",
      sourceSubject(path, digest),
      { path, digest, visibility },
      assertion,
    );
    return { path, digest, body: readFileSync(join(service.workspace, path), "utf8") };
  });
  const pending: any = service.callTool("request_direction_approval", {
    session,
    rationale: "Fixture owner approval for the Service authority tests.",
    direction: proposedDirection(source),
  });
  assert.equal(pending.ok, true);
  service.ownerDecide("approve", pending.result.request_id, pending.result.digest, assertion);
  return { session, sources, assertion };
}
function proposedDirection(source: { idea: string; audience: string; source_paths: string[] }) {
  return {
    idea: source.idea,
    audience: source.audience,
    source_paths: source.source_paths,
    restricted_sources: [],
    reader_question: "How do you test before buying software?",
    angle: "Cheap fixes first.",
    reader_promise: "A bounded test.",
    exclusions: ["Do not claim success"],
  };
}
function grantAll(service: StudioService, authority: ReturnType<typeof authorizeRun>) {
  for (const [index, source] of authority.sources.entries())
    service.ownerChannelForTesting().decide("disclosure_grant", "grant-" + index, {
      path: source.path, digest: source.digest, session: authority.session, host: "other", purpose: "drafting",
      roles: ["director", "writer", "fact_reviewer"], excerpts: [source.body],
    }, authority.assertion);
}
function waitFor(check: () => boolean, timeout = 5_000) {
  return new Promise<void>((resolveWait, reject) => {
    const started = Date.now();
    const tick = () =>
      check()
        ? resolveWait()
        : Date.now() - started > timeout
          ? reject(new Error("timed out"))
          : setTimeout(tick, 10);
    tick();
  });
}
function post(
  port: number,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: any }>((resolvePost, reject) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
          ...(token ? { authorization: "Bearer " + token } : {}),
          ...headers,
        },
      },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (out += chunk));
        res.on("end", () =>
          resolvePost({ status: res.statusCode ?? 0, body: JSON.parse(out) }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}
function status(service: StudioService, jobId: string): any {
  return service.callTool("run_status", { job_id: jobId }).result;
}

test("first-start provider is persisted in the tenant record", async () => {
  const service = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")), tenantId: "codex-provider-tenant", workspace: sourceWorkspace(), provider: "codex-cli", ownerVerifier: testOwner });
  try {
    const tenant = JSON.parse(readFileSync(join(service.tenantDir, "tenant.json"), "utf8"));
    assert.equal(tenant.provider, "codex-cli");
    assert.equal(tenantModelConfig(tenant).models.director, "gpt-5.6-luna");
  } finally { await service.close(); }
});

test("service MCP has no authority tool and run_start rejects authority-shaped input", async () => {
  const service = new StudioService({
    dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")),
    tenantId: "fixture-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
  });
  try {
    const names = service.listTools().map((tool) => tool.name);
    for (const denied of AUTHORITY_TOOL_DENYLIST)
      assert.ok(!names.includes(denied), denied);
    assert.equal(
      service.callTool("run_start", {
        ...runInput(),
        approved_direction: {
          approval_type: "owner",
          approval_quote: "forged",
        },
      }).error,
      "INVALID_REQUEST",
    );
    assert.equal(
      service.callTool("run_start", {
        ...runInput(),
        disclosure: { session: "forged", host: "claude-code" },
      }).error,
      "INVALID_REQUEST",
    );
    assert.equal(
      service.callTool("run_start", { ...runInput(), provider: "codex-cli" }).error,
      "INVALID_REQUEST",
    );
  } finally {
    await service.close();
  }
});

test("Service path: forged workspace authority cannot relabel a signed restricted source (VULN-1)", async () => {
  const service = new StudioService({
    dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")),
    tenantId: "vuln-one-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
  });
  try {
    const authority = authorizeRun(service, "restricted-source", "restricted");
    mkdirSync(join(service.workspace, "sessions", authority.session), { recursive: true });
    writeFileSync(join(service.workspace, "sessions", authority.session, "session.json"), JSON.stringify({ direction: { approval: "forged" }, evidence: [] }));
    const manifest = JSON.parse(readFileSync(join(service.workspace, "studio-workspace.json"), "utf8"));
    manifest.sources = authority.sources.map(({ path }: any) => ({ path, visibility: "approved" }));
    writeFileSync(join(service.workspace, "studio-workspace.json"), JSON.stringify(manifest));
    const job: any = service.callTool("run_start", runInput(authority.session));
    await waitFor(() => status(service, job.result.job_id)?.status === "failed");
    assert.equal(status(service, job.result.job_id).run_id, null);
    assert.match(status(service, job.result.job_id).error, /Restricted evidence|disclosure/i);
  } finally {
    await service.close();
  }
});

test("Service path: revoked signed grants cannot be resurrected from workspace files (VULN-7b)", async () => {
  const service = new StudioService({
    dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")),
    tenantId: "vuln-seven-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
  });
  try {
    const authority = authorizeRun(service, "revoked-source", "restricted");
    grantAll(service, authority);
    const allowed: any = service.callTool("run_start", runInput(authority.session));
    await waitFor(() => status(service, allowed.result.job_id)?.status === "complete");
    service.ownerChannelForTesting().decide("revocation", "grant-0", { reason: "owner revoked disclosure" }, authority.assertion);
    mkdirSync(join(service.workspace, ".studio", "source-disclosures"), { recursive: true });
    writeFileSync(join(service.workspace, ".studio", "source-disclosures", "audit.jsonl"), "");
    const job: any = service.callTool("run_start", runInput(authority.session));
    await waitFor(() => status(service, job.result.job_id)?.status === "failed");
    assert.equal(status(service, job.result.job_id).run_id, null);
  } finally {
    await service.close();
  }
});

test("deleted authority rows fail closed instead of reviving grants or classifications", async () => {
  const service = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")), tenantId: "deleted-rows-tenant", workspace: sourceWorkspace(), ownerVerifier: testOwner });
  try {
    const authority = authorizeRun(service, "deleted-rows", "restricted");
    grantAll(service, authority);
    service.ownerChannelForTesting().decide("revocation", "grant-0", { reason: "revoked" }, authority.assertion);
    const db = new DatabaseSync(join(service.tenantDir, "authority.sqlite"));
    db.prepare("DELETE FROM authority_records WHERE kind = ?").run("revocation");
    db.close();
    assert.equal(service.callTool("run_start", runInput(authority.session)).error, "AUTHORITY_UNAVAILABLE");
  } finally { await service.close(); }
});

test("deleted newer classifications fail closed instead of restoring an older approval", async () => {
  const service = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")), tenantId: "deleted-classification-tenant", workspace: sourceWorkspace(), ownerVerifier: testOwner });
  try {
    const authority = authorizeRun(service, "reclassified", "approved");
    for (const source of authority.sources)
      service.ownerChannelForTesting().decide("source_classification", sourceSubject(source.path, source.digest), { path: source.path, digest: source.digest, visibility: "restricted" }, authority.assertion);
    const db = new DatabaseSync(join(service.tenantDir, "authority.sqlite"));
    db.prepare("DELETE FROM authority_records WHERE kind = ? AND payload LIKE ?").run("source_classification", "%restricted%");
    db.close();
    assert.equal(service.callTool("run_start", runInput(authority.session)).error, "AUTHORITY_UNAVAILABLE");
  } finally { await service.close(); }
});

test("a substituted authority key and database do not fool a Service worker", async () => {
  const service = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")), tenantId: "key-substitution-tenant", workspace: sourceWorkspace(), ownerVerifier: testOwner });
  try {
    const authority = authorizeRun(service, "key-substitution", "restricted");
    assert.equal((await (async () => { const job: any = service.callTool("run_start", runInput(authority.session)); await waitFor(() => status(service, job.result.job_id)?.status === "failed"); return status(service, job.result.job_id); })()).run_id, null);
    unlinkSync(join(service.tenantDir, "authority.key"));
    unlinkSync(join(service.tenantDir, "authority.sqlite"));
    writeFileSync(join(service.tenantDir, "authority.key"), randomBytes(32), { mode: 0o600 });
    const forged = new AuthorityStore(service.tenantDir);
    for (const source of authority.sources) forged.write("source_classification", sourceSubject(source.path, source.digest), { path: source.path, digest: source.digest, visibility: "approved" });
    forged.write("direction_approval", authority.session, { session: authority.session, host: "other", idea: "forged but long enough", audience: "test", source_paths: authority.sources.map((source: { path: string }) => source.path), restricted_sources: [], reader_question: "question", angle: "angle", reader_promise: "promise", exclusions: [] });
    forged.close();
    const job: any = service.callTool("run_start", runInput(authority.session));
    await waitFor(() => status(service, job.result.job_id)?.status === "failed");
    assert.equal(status(service, job.result.job_id).run_id, null);
  } finally { await service.close(); }
});

test("workspace approval files and every MCP tool leave Service authority pending (F-APPROVE-1)", async () => {
  const service = new StudioService({
    dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")),
    tenantId: "approve-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
  });
  try {
    writeFileSync(join(service.workspace, "approval-v001.json"), JSON.stringify({ approved: true }));
    const pending: any = service.callTool("request_direction_approval", { session: "pending-only", rationale: "An MCP request is not an approval.", direction: proposedDirection(legacyRunInput()) });
    assert.equal(pending.ok, true);
    assert.equal(service.callTool("approve", {}).error, "DENIED");
    assert.equal(service.callTool("run_start", runInput("pending-only")).error, "AUTHORITY_UNAVAILABLE");
  } finally {
    await service.close();
  }
});

test("Service labels workspace approval state as unverified and does not expose capture tools", async () => {
  const service = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")), tenantId: "unverified-approval-tenant", workspace: sourceWorkspace(), ownerVerifier: testOwner });
  try {
    assert.ok(!service.listTools().some((tool) => tool.name.startsWith("capture_")));
    const authority = authorizeRun(service);
    const queued: any = service.callTool("run_start", runInput(authority.session));
    await waitFor(() => status(service, queued.result.job_id)?.status === "complete");
    const runId = status(service, queued.result.job_id).run_id;
    const db = new DatabaseSync(join(service.workspace, ".studio", "runs.sqlite"));
    db.prepare("UPDATE runs SET status = ? WHERE run_id = ?").run("ASSET_APPROVED", runId);
    db.close();
    assert.equal(status(service, queued.result.job_id).run.status, "UNVERIFIED_WORKSPACE_STATUS");
  } finally { await service.close(); }
});

test("tenant provider, budget, and specialist fields cannot be changed by MCP callers or job files", async () => {
  const service = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")), tenantId: "job-allowlist-tenant", workspace: sourceWorkspace(), ownerVerifier: testOwner });
  try {
    const authority = authorizeRun(service);
    const first: any = service.callTool("run_start", runInput(authority.session));
    await waitFor(() => status(service, first.result.job_id)?.status === "complete");
    const original = JSON.parse(readFileSync(join(service.tenantDir, "jobs", first.result.job_id + ".json"), "utf8"));
    const jobId = "job-" + "a".repeat(16);
    writeFileSync(join(service.tenantDir, "jobs", jobId + ".json"), JSON.stringify({ ...original, job_id: jobId, status: "queued", run_id: null, worker_pid: null, request: { ...original.request, provider: "codex-cli", models: { director: "gpt-5.3-codex", writer: "gpt-5.3-codex", fact_reviewer: "gpt-5.3-codex", craft_reviewer: "gpt-5.3-codex" }, specialist: "conversion-copywriting", budget: { max_model_calls: 24, max_steps: 80, max_revision_rounds: 2 } } }));
    service.kick();
    await waitFor(() => status(service, jobId)?.status === "complete");
    const runs = new DatabaseSync(join(service.workspace, ".studio", "runs.sqlite"));
    const request = JSON.parse((runs.prepare("SELECT request_json FROM runs WHERE run_id = ?").get(status(service, jobId).run_id) as { request_json: string }).request_json);
    runs.close();
    assert.equal(request.provider, "fixture");
    assert.equal(request.specialist, undefined);
    assert.equal(request.budget.max_model_calls, 12);
  } finally { await service.close(); }
});

test("tampered authority rows fail closed", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "studio-service-data-"));
  const first = new StudioService({ dataRoot, tenantId: "tamper-tenant", workspace: sourceWorkspace(), ownerVerifier: testOwner });
  authorizeRun(first);
  const dbPath = join(first.tenantDir, "authority.sqlite");
  await first.close();
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE authority_records SET payload = ? WHERE kind = ?").run("{}", "direction_approval");
  db.close();
  const second = new StudioService({ dataRoot, tenantId: "tamper-tenant", ownerVerifier: testOwner });
  try {
    assert.equal(second.callTool("run_start", runInput()).error, "AUTHORITY_UNAVAILABLE");
  } finally {
    await second.close();
  }
});

test("HTTP MCP rejects missing tokens, foreign Origins, oversized requests, and rate excess", async () => {
  const service = new StudioService({
    dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")),
    tenantId: "http-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
    rateLimit: 2,
  });
  const port = await service.listen();
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  try {
    assert.equal((await post(port, null, rpc)).status, 401);
    assert.equal((await post(port, "wrong", rpc)).status, 401);
    assert.equal(
      (
        await post(port, service.token, rpc, {
          origin: "https://attacker.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (await post(port, service.token, rpc, { host: "localhost:" + port }))
        .status,
      403,
    );
    assert.equal(
      (await post(port, service.token, "x".repeat(MAX_HTTP_REQUEST_BYTES + 1)))
        .status,
      413,
    );
    assert.equal((await post(port, service.token, rpc)).status, 200);
    assert.equal((await post(port, service.token, rpc)).status, 429);
  } finally {
    await service.close();
  }
});

test("a slow worker does not block run_status", async () => {
  const service = new StudioService({
    dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")),
    tenantId: "slow-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
    fixtureDelayMs: 1_500,
  });
  const port = await service.listen();
  try {
    authorizeRun(service);
    const started = await post(port, service.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run_start", arguments: runInput() },
    });
    const jobId = JSON.parse(started.body.result.content[0].text).job_id;
    await waitFor(() => !!status(service, jobId).run_id);
    const began = Date.now();
    const polled = await post(port, service.token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "run_status", arguments: { job_id: jobId } },
    });
    assert.equal(polled.status, 200);
    assert.ok(Date.now() - began < 2_000);
  } finally {
    await service.close();
  }
});

test("restart preserves copied sessions and durable async jobs", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "studio-service-data-"));
  const first = new StudioService({
    dataRoot,
    tenantId: "restart-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
  });
  sessionStart(
    first.workspace,
    "A synthetic idea for a durable service test",
    "service-session",
  );
  authorizeRun(first);
  const queued: any = first.callTool("run_start", runInput());
  assert.equal(queued.ok, true);
  await waitFor(
    () => status(first, queued.result.job_id)?.status === "complete",
  );
  await first.close();
  const second = new StudioService({ dataRoot, tenantId: "restart-tenant" });
  try {
    assert.equal(status(second, queued.result.job_id).run.model_calls, 4);
    assert.equal(
      (second.callTool("session_status", {}).result as any)[0].session,
      "service-session",
    );
  } finally {
    await second.close();
  }
});

test("two back-to-back jobs run one at a time and both complete", async () => {
  const service = new StudioService({
    dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")),
    tenantId: "serial-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
    fixtureDelayMs: 50,
  });
  try {
    authorizeRun(service);
    const first: any = service.callTool("run_start", runInput());
    const second: any = service.callTool("run_start", runInput());
    await waitFor(
      () =>
        status(service, first.result.job_id)?.status === "complete" &&
        status(service, second.result.job_id)?.status === "complete",
    );
    assert.equal(status(service, first.result.job_id).error, null);
    assert.equal(status(service, second.result.job_id).error, null);
  } finally {
    await service.close();
  }
});

test("kill -9 during a model call reuses completed receipts and records unknown usage", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "studio-service-data-"));
  const log = join(dataRoot, "calls.log");
  const first = new StudioService({
    dataRoot,
    tenantId: "kill-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
    fixtureBlockRole: "fact_reviewer",
    fixtureLogPath: log,
  });
  authorizeRun(first);
  const queued: any = first.callTool("run_start", runInput());
  const jobId = queued.result.job_id;
  await waitFor(
    () =>
      existsSync(log) && readFileSync(log, "utf8").includes("fact_reviewer"),
  );
  const jobFile = join(first.tenantDir, "jobs", jobId + ".json");
  const live = JSON.parse(readFileSync(jobFile, "utf8"));
  process.kill(live.worker_pid, "SIGKILL");
  await first.close();
  await waitFor(() => {
    try {
      process.kill(live.worker_pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  const recovered = new StudioService({
    dataRoot,
    tenantId: "kill-tenant",
    fixtureLogPath: log,
  });
  try {
    recovered.kick();
    await waitFor(() => status(recovered, jobId)?.status === "complete");
    const result = status(recovered, jobId);
    const run = inspectRun(recovered.workspace, result.run_id);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[1]);
    assert.deepEqual(calls, [
      "director",
      "writer",
      "fact_reviewer",
      "fact_reviewer",
      "craft_reviewer",
    ]);
    assert.equal(run.calls, 5);
    assert.ok(
      run.events.some(
        (event) =>
          event.event_type === "usage_unknown" &&
          event.details_json.includes("fact_v001"),
      ),
    );
  } finally {
    await recovered.close();
  }
});

test("service tenant lock and malformed jobs cannot wedge a restart", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "studio-service-data-"));
  const first = new StudioService({
    dataRoot,
    tenantId: "lock-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
  });
  authorizeRun(first);
  assert.throws(
    () => new StudioService({ dataRoot, tenantId: "lock-tenant" }),
    /already running/,
  );
  await first.close();
  writeFileSync(
    join(first.tenantDir, "jobs", "job-0000000000000000.json"),
    "{}",
  );
  const second = new StudioService({ dataRoot, tenantId: "lock-tenant" });
  try {
    const queued: any = second.callTool("run_start", runInput());
    await waitFor(
      () => status(second, queued.result.job_id)?.status === "complete",
    );
  } finally {
    await second.close();
  }
});

test("an unreadable runner lock fails once instead of retrying forever", async () => {
  const service = new StudioService({
    dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")),
    tenantId: "unreadable-lock-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
  });
  try {
    authorizeRun(service);
    mkdirSync(join(service.workspace, ".studio"), { recursive: true });
    writeFileSync(join(service.workspace, ".studio", "runner.lock"), "");
    const queued: any = service.callTool("run_start", runInput());
    await waitFor(
      () => status(service, queued.result.job_id)?.status === "failed",
    );
    assert.match(
      status(service, queued.result.job_id).error,
      /Unreadable lock file/,
    );
  } finally {
    await service.close();
  }
});

test("a reused worker PID cannot wedge the tenant queue", async () => {
  const service = new StudioService({
    dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")),
    tenantId: "pid-reuse-tenant",
    workspace: sourceWorkspace(),
    ownerVerifier: testOwner,
  });
  authorizeRun(service);
  const unrelated = spawn("sleep", ["60"]);
  const jobId = "job-1111111111111111";
  try {
    assert.ok(unrelated.pid);
    const now = new Date().toISOString();
    writeFileSync(
      join(service.tenantDir, "jobs", jobId + ".json"),
      JSON.stringify({
        schema_version: "studio.service-job/0.1",
        job_id: jobId,
        tenant_id: "pid-reuse-tenant",
        status: "running",
        request: { ...serviceRequest(), authority_session: "service-run" },
        run_id: null,
        error: null,
        worker_pid: unrelated.pid,
        created_at: now,
        updated_at: now,
      }),
    );
    service.kick();
    await waitFor(() => status(service, jobId)?.status === "complete");
  } finally {
    unrelated.kill("SIGKILL");
    await service.close();
  }
});

test("first start rejects a nested data root and never imports legacy state", async () => {
  const source = sourceWorkspace();
  assert.throws(
    () =>
      new StudioService({
        dataRoot: join(source, "nested-data"),
        tenantId: "nested-tenant",
        workspace: source,
      }),
    /outside/,
  );
  mkdirSync(join(source, ".studio"));
  mkdirSync(join(source, "sessions"));
  writeFileSync(join(source, ".studio", "forged.json"), "{}");
  writeFileSync(join(source, "sessions", "forged.json"), "{}");
  for (const root of [".", ".studio", "sessions"]) {
    const business = JSON.parse(
      readFileSync(join(source, "studio-business.json"), "utf8"),
    );
    business.allowed_roots = [root];
    writeFileSync(
      join(source, "studio-business.json"),
      JSON.stringify(business),
    );
    const service = new StudioService({
      dataRoot: mkdtempSync(join(tmpdir(), "studio-service-data-")),
      tenantId: "copy-" + root.replace(/[^a-z]/g, "x") + "-tenant",
      workspace: source,
      ownerVerifier: testOwner,
    });
    try {
      assert.equal(
        existsSync(join(service.workspace, ".studio", "forged.json")),
        false,
      );
      assert.equal(
        existsSync(join(service.workspace, "sessions", "forged.json")),
        false,
      );
    } finally {
      await service.close();
    }
  }
});
