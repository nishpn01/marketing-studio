/**
 * Owner Inbox v0 (M1.4): passkey-gated decisions over HTTP with a software authenticator.
 * Every refusal test also proves the same request is approvable with a correct assertion (positive control).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudioService, ownerConsoleLine } from "../src/service/studio-service.ts";
import { AuthorityStore, sourceSubject } from "../src/service/authority-store.ts";
import { OwnerChannel } from "../src/service/owner-channel.ts";
import { hash, REPO_ROOT } from "../src/runner.ts";
import { sourceWorkspace } from "./helpers/service-fixture.ts";
import { TestOwnerVerifier } from "./helpers/test-owner-verifier.ts";
import { DRAFT, Flow } from "./helpers/program-flow.ts";
import { VirtualAuthenticator, type AssertOverrides } from "./helpers/virtual-authenticator.ts";

const fixture = JSON.parse(readFileSync(join(REPO_ROOT, "studio-runner/fixtures/agent-sample/request.json"), "utf8"));
const direction = {
  idea: fixture.idea,
  audience: fixture.audience,
  source_paths: fixture.source_paths,
  reader_question: "How do you test before buying software?",
  angle: "Cheap fixes first.",
  reader_promise: "A bounded test.",
  exclusions: ["Do not claim success"],
};
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; body: any };

function http(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<Reply>((resolveReply, reject) => {
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { ...(text ? { "content-length": String(Buffer.byteLength(text)) } : {}), ...headers } }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (out += chunk));
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(out); } catch {}
        resolveReply({ status: res.statusCode ?? 0, headers: res.headers, text: out, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(text);
  });
}

/** Holds the inbox cookie and CSRF token like a same-origin page would. */
class Browser {
  readonly port: number;
  cookie = "";
  csrf = "";
  constructor(port: number) { this.port = port; }
  headers(extra: Record<string, string> = {}) {
    return { host: "localhost:" + this.port, origin: "http://localhost:" + this.port, "content-type": "application/json", cookie: this.cookie, "x-inbox-csrf": this.csrf, ...extra };
  }
  async get(path: string, extra: Record<string, string> = {}) {
    const reply = await http(this.port, "GET", path, { host: "localhost:" + this.port, ...(this.cookie ? { cookie: this.cookie } : {}), ...extra });
    const cookie = String(reply.headers["set-cookie"] ?? "").split(";")[0];
    if (cookie.startsWith("inbox_csrf=")) this.cookie = cookie;
    this.csrf = /<meta name="inbox-csrf" content="([^"]+)">/.exec(reply.text)?.[1] ?? this.csrf;
    return reply;
  }
  post(path: string, body: unknown, extra: Record<string, string> = {}, omit: string[] = []) {
    const headers = this.headers(extra);
    for (const name of omit) delete (headers as Record<string, string>)[name];
    return http(this.port, "POST", path, headers, body);
  }
}
type Ctx = { service: StudioService; port: number; browser: Browser; auth: VirtualAuthenticator };

async function owner(tenantId: string, counter = 5): Promise<Ctx> {
  const service = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-inbox-data-")), tenantId, workspace: sourceWorkspace() });
  const port = await service.listen();
  const code = service.ownerSetupCode();
  assert.ok(code);
  const browser = new Browser(port), auth = new VirtualAuthenticator("http://localhost:" + port, counter);
  await browser.get("/inbox/setup");
  const options = await browser.post("/inbox/api/register-options", { code });
  assert.equal(options.status, 200, options.text);
  const registered = await browser.post("/inbox/api/register", { code, credential: auth.register(options.body) });
  assert.equal(registered.status, 200, registered.text);
  // Source classification is not an inbox action yet; provision it directly in the signed store.
  const store = new AuthorityStore(service.tenantDir);
  for (const path of fixture.source_paths as string[]) {
    const digest = hash(readFileSync(join(service.workspace, path), "utf8"));
    store.write("source_classification", sourceSubject(path, digest), { path, digest, visibility: "approved" });
  }
  store.close();
  return { service, port, browser, auth };
}
function propose(service: StudioService, session: string) {
  const out: any = service.callTool("request_direction_approval", { session, rationale: "The owner asked for a reminder-test story.", direction });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.result.request_id as string;
}
/** Reads the decision buttons the page rendered: what the owner was shown. */
async function shown(ctx: Ctx, path: string) {
  const page = await ctx.browser.get(path);
  const match = /data-action="([a-z_]+)" data-target="([^"]+)" data-digest="([0-9a-f]{64})"/.exec(page.text);
  assert.ok(match, page.text);
  return { target: match[2], digest: match[3], html: page.text };
}
async function decide(ctx: Ctx, action: string, target: string, digest: string, o: AssertOverrides = {}, challengeTarget = target) {
  const challenge = await ctx.browser.post("/inbox/api/challenge", { action, target: challengeTarget, digest: challengeTarget === target ? digest : (await shown(ctx, "/inbox/requests/" + challengeTarget)).digest });
  assert.equal(challenge.status, 200, challenge.text);
  return ctx.browser.post("/inbox/api/decide", { action, target, digest, credential: ctx.auth.assert(challenge.body, o) });
}
const blocked = (service: StudioService, session: string) => service.callTool("run_start", { session }).error === "AUTHORITY_UNAVAILABLE";
function waitFor(check: () => boolean, timeout = 10_000) {
  return new Promise<void>((resolveWait, reject) => {
    const started = Date.now();
    const tick = () => (check() ? resolveWait() : Date.now() - started > timeout ? reject(new Error("timed out")) : setTimeout(tick, 20));
    tick();
  });
}
const status = (service: StudioService, jobId: string): any => service.callTool("run_status", { job_id: jobId }).result;

test("passkey E2E: register, approve the shown direction, then run_start succeeds", async () => {
  const ctx = await owner("inbox-e2e");
  try {
    const requestId = propose(ctx.service, "inbox-session");
    assert.ok(blocked(ctx.service, "inbox-session"), "a pending request must not authorize a run");
    assert.match((await ctx.browser.get("/inbox")).text, new RegExp(requestId));
    const { target, digest, html } = await shown(ctx, "/inbox/requests/" + requestId);
    assert.match(html, /Cheap fixes first\./);
    const decided = await decide(ctx, "approve", target, digest);
    assert.equal(decided.status, 200, decided.text);
    const job: any = ctx.service.callTool("run_start", { session: "inbox-session" });
    assert.equal(job.ok, true);
    await waitFor(() => status(ctx.service, job.result.job_id)?.status === "complete");
    assert.doesNotMatch((await ctx.browser.get("/inbox")).text, new RegExp(requestId));
  } finally { await ctx.service.close(); }
});

test("owner inbox E2E: same-origin idea promotion creates exactly one pending request", async () => {
  const ctx = await owner("inbox-idea-promote");
  try {
    const sourceRef = "commit-for-inbox-test";
    writeFileSync(join(ctx.service.tenantDir, "proactive-digest-refs.json"), JSON.stringify({ refs: [sourceRef], generation: "digest-test" }));
    const submitted: any = ctx.service.ideaSubmit({ ideas: [{ kind: "content_idea", title: "Inbox idea", rationale: "A useful test idea.", source_refs: [sourceRef] }] });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    const ideaId = submitted.result.accepted[0].id;
    assert.equal((await ctx.browser.get(`/inbox/ideas/${ideaId}`)).status, 200);

    const promoted = await ctx.browser.post("/inbox/api/idea_promote", { id: ideaId });
    assert.equal(promoted.status, 200, promoted.text);
    assert.equal(promoted.body.ok, true, promoted.text);
    assert.equal(promoted.body.result.status, "pending");
    assert.equal(ctx.service.pendingRequests().length, 1);
  } finally { await ctx.service.close(); }
});

const refusals: [string, (ctx: Ctx, target: string, digest: string) => Promise<Reply>][] = [
  ["no assertion", (ctx, target, digest) => ctx.browser.post("/inbox/api/decide", { action: "approve", target, digest })],
  ["wrong origin", (ctx, target, digest) => decide(ctx, "approve", target, digest, { origin: "http://127.0.0.1:" + ctx.port })],
  ["wrong rpId", (ctx, target, digest) => decide(ctx, "approve", target, digest, { rpId: "evil.example" })],
  ["user-presence flag cleared", (ctx, target, digest) => decide(ctx, "approve", target, digest, { flags: 0x04 })],
  ["user-verification flag cleared", (ctx, target, digest) => decide(ctx, "approve", target, digest, { flags: 0x01 })],
  ["signature counter regression", (ctx, target, digest) => decide(ctx, "approve", target, digest, { counter: 5 })],
  ["signature from another key", (ctx, target, digest) => decide(ctx, "approve", target, digest, { resign: true })],
  ["registration ceremony type", (ctx, target, digest) => decide(ctx, "approve", target, digest, { type: "webauthn.create" })],
  ["challenge issued for a different request", (ctx, target, digest) => decide(ctx, "approve", target, digest, {}, propose(ctx.service, "other-session"))],
  ["replayed challenge", async (ctx, target, digest) => {
    const challenge = await ctx.browser.post("/inbox/api/challenge", { action: "approve", target, digest });
    const credential = ctx.auth.assert(challenge.body);
    const first = await ctx.browser.post("/inbox/api/decide", { action: "reject", target, digest, credential });
    assert.equal(first.status, 409, "an assertion for approve must not reject");
    return ctx.browser.post("/inbox/api/decide", { action: "approve", target, digest, credential });
  }],
];
for (const [name, attempt] of refusals)
  test(`refused owner decision: ${name}; the run stays blocked until a valid assertion`, async () => {
    const ctx = await owner("inbox-refusal-" + name.replace(/[^a-z]+/g, "-").slice(0, 40).replace(/-$/, ""));
    try {
      const requestId = propose(ctx.service, "refusal-session");
      const { target, digest } = await shown(ctx, "/inbox/requests/" + requestId);
      const refused = await attempt(ctx, target, digest);
      assert.notEqual(refused.status, 200, refused.text);
      assert.ok(blocked(ctx.service, "refusal-session"));
      const control = await decide(ctx, "approve", target, digest);
      assert.equal(control.status, 200, control.text);
      assert.equal(ctx.service.callTool("run_start", { session: "refusal-session" }).ok, true);
    } finally { await ctx.service.close(); }
  });

test("bearer MCP token cannot drive any inbox route, and MCP has no decision tool", async () => {
  const ctx = await owner("inbox-bearer");
  try {
    const requestId = propose(ctx.service, "bearer-session");
    const { target, digest } = await shown(ctx, "/inbox/requests/" + requestId);
    const bearer = { authorization: "Bearer " + ctx.service.token };
    for (const path of ["/inbox/api/challenge", "/inbox/api/decide", "/inbox/api/register-options", "/inbox/api/register"])
      assert.equal((await ctx.browser.post(path, { action: "approve", target, digest }, bearer)).status, 401, path);
    const challenge = await ctx.browser.post("/inbox/api/challenge", { action: "approve", target, digest });
    const credential = ctx.auth.assert(challenge.body);
    assert.equal((await ctx.browser.post("/inbox/api/decide", { action: "approve", target, digest, credential }, bearer)).status, 401);
    assert.equal((await ctx.browser.get("/inbox", bearer)).status, 401);
    for (const name of ["approve", "decide", "owner_decide", "ownerDecide", "register", "approve_version", "revoke"]) {
      const out = await http(ctx.port, "POST", "/mcp", { host: "127.0.0.1:" + ctx.port, "content-type": "application/json", ...bearer }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { target, digest } } });
      assert.equal(out.body.result.isError, true, name);
    }
    assert.ok(!ctx.service.listTools().some((tool) => /^(approve|grant|revoke|register|decide)|owner|inbox/.test(tool.name)));
    assert.ok(blocked(ctx.service, "bearer-session"));
    // Positive control: the same assertion, sent without the bearer header, is accepted.
    assert.equal((await ctx.browser.post("/inbox/api/decide", { action: "approve", target, digest, credential })).status, 200);
    assert.equal(blocked(ctx.service, "bearer-session"), false);
  } finally { await ctx.service.close(); }
});

test("GET never mutates: pages, links and GET on action routes leave authority unchanged", async () => {
  const ctx = await owner("inbox-get");
  try {
    const requestId = propose(ctx.service, "get-session");
    const { target, digest } = await shown(ctx, "/inbox/requests/" + requestId);
    const store = new AuthorityStore(ctx.service.tenantDir), before = store.size();
    for (const path of ["/inbox", "/inbox/", "/inbox/setup", "/inbox/requests/" + requestId, `/inbox/requests/${requestId}?action=approve&digest=${digest}`])
      assert.equal((await ctx.browser.get(path)).status, 200, path);
    for (const path of ["/inbox/api/decide", "/inbox/api/challenge", `/inbox/api/decide?action=approve&target=${target}&digest=${digest}`, "/inbox/api/register"])
      assert.equal((await ctx.browser.get(path)).status, 404, path);
    for (const method of ["PUT", "DELETE", "PATCH"])
      assert.equal((await http(ctx.port, method, "/inbox/api/decide", ctx.browser.headers(), { action: "approve", target, digest })).status, 405, method);
    assert.equal(store.size(), before);
    store.close();
    assert.ok(blocked(ctx.service, "get-session"));
    assert.equal(ctx.service.pendingRequests().length, 1);
  } finally { await ctx.service.close(); }
});

test("CSRF, Origin and Host checks refuse a valid assertion until the request is same-origin", async () => {
  const ctx = await owner("inbox-csrf");
  try {
    const requestId = propose(ctx.service, "csrf-session");
    const { target, digest } = await shown(ctx, "/inbox/requests/" + requestId);
    const cases: [string, Record<string, string>, string[]][] = [
      ["missing Origin", {}, ["origin"]],
      ["foreign Origin", { origin: "https://evil.example" }, []],
      ["MCP origin", { origin: "http://127.0.0.1:" + ctx.port }, []],
      ["MCP Host", { host: "127.0.0.1:" + ctx.port }, []],
      ["rebinding Host", { host: "evil.example:" + ctx.port }, []],
      ["cross-site fetch", { "sec-fetch-site": "cross-site" }, []],
      ["missing CSRF token", {}, ["x-inbox-csrf"]],
      ["wrong CSRF token", { "x-inbox-csrf": "forged" }, []],
      ["missing cookie", {}, ["cookie"]],
      ["form encoding", { "content-type": "application/x-www-form-urlencoded" }, []],
    ];
    let credential: ReturnType<VirtualAuthenticator["assert"]> | null = null;
    for (const [name, extra, omit] of cases) {
      const challenge = await ctx.browser.post("/inbox/api/challenge", { action: "approve", target, digest });
      credential = ctx.auth.assert(challenge.body);
      const refused = await ctx.browser.post("/inbox/api/decide", { action: "approve", target, digest, credential }, extra, omit);
      assert.ok([403, 415].includes(refused.status), name + ": " + refused.status);
      assert.ok(blocked(ctx.service, "csrf-session"), name);
    }
    // Positive control: the last refused assertion passes once the headers are right.
    assert.equal((await ctx.browser.post("/inbox/api/decide", { action: "approve", target, digest, credential })).status, 200);
    assert.equal(blocked(ctx.service, "csrf-session"), false);
  } finally { await ctx.service.close(); }
});

test("A7: a tampered pending file changes nothing the owner sees or approves", async () => {
  const ctx = await owner("inbox-a7-file");
  try {
    const requestId = propose(ctx.service, "owner-saw-this");
    const file = join(ctx.service.tenantDir, "pending", requestId + ".json");
    const pending = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...pending, session: "agent-swapped", direction: { ...pending.direction, angle: "Agent-chosen angle" } }));
    const { target, digest, html } = await shown(ctx, "/inbox/requests/" + requestId);
    assert.match(html, /owner-saw-this/);
    assert.doesNotMatch(html, /agent-swapped|Agent-chosen angle/);
    assert.equal((await decide(ctx, "approve", target, digest)).status, 200);
    assert.ok(blocked(ctx.service, "agent-swapped"));
    assert.equal(blocked(ctx.service, "owner-saw-this"), false);
  } finally { await ctx.service.close(); }
});

test("A7: a tampered signed snapshot is refused; a decided request cannot be completed again", async () => {
  const ctx = await owner("inbox-a7-store");
  try {
    const first = propose(ctx.service, "decided-once");
    const shownFirst = await shown(ctx, "/inbox/requests/" + first);
    assert.equal((await decide(ctx, "reject", shownFirst.target, shownFirst.digest)).status, 200);
    assert.ok(blocked(ctx.service, "decided-once"));
    // A second completion (approve after reject) cannot even get a challenge, and the page says so.
    assert.equal((await ctx.browser.post("/inbox/api/challenge", { action: "approve", target: shownFirst.target, digest: shownFirst.digest })).status, 409);
    assert.match((await ctx.browser.get("/inbox/requests/" + first)).text, /already decided/);
    assert.ok(blocked(ctx.service, "decided-once"));

    const second = propose(ctx.service, "tampered-row");
    const shownSecond = await shown(ctx, "/inbox/requests/" + second);
    const challenge = await ctx.browser.post("/inbox/api/challenge", { action: "approve", target: shownSecond.target, digest: shownSecond.digest });
    const db = new DatabaseSync(join(ctx.service.tenantDir, "authority.sqlite"));
    db.prepare("UPDATE authority_records SET payload = replace(payload, 'tampered-row', 'agent-swapped') WHERE kind = 'pending_request' AND subject = ?").run(second);
    db.close();
    const refused = await ctx.browser.post("/inbox/api/decide", { action: "approve", target: shownSecond.target, digest: shownSecond.digest, credential: ctx.auth.assert(challenge.body) });
    assert.equal(refused.status, 409);
    assert.ok(blocked(ctx.service, "tampered-row") && blocked(ctx.service, "agent-swapped"));
  } finally { await ctx.service.close(); }
});

test("the store consumes an owner decision exactly once, even if two completions race past the inbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "studio-once-"));
  const store = new AuthorityStore(dir), owner = new TestOwnerVerifier(), channel = new OwnerChannel(store, owner);
  const binding = { action: "approve", target: "pending-0123456789abcdef", digest: "0".repeat(64) };
  channel.resolve(binding, owner.assertion(), [{ kind: "direction_approval", subject: "raced", payload: { session: "raced" } }]);
  assert.throws(() => channel.resolve(binding, owner.assertion(), [{ kind: "direction_approval", subject: "raced", payload: { session: "raced", angle: "second" } }]), /already decided/);
  assert.equal(store.latest("direction_approval", "raced")?.angle, undefined);
  store.close();
});

test("disclosure grants: the owner grants the shown excerpt, then revokes it with a fresh passkey", async () => {
  const ctx = await owner("inbox-grant");
  try {
    const path = fixture.source_paths[0] as string, body = readFileSync(join(ctx.service.workspace, path), "utf8");
    const excerpt = body.split("\n").find((line: string) => line.trim().length > 20)!;
    assert.equal(ctx.service.callTool("request_disclosure_grant", { session: "grant-session", rationale: "Writer needs one line.", path, roles: ["writer"], excerpts: ["not in the source at all"] }).error, "INVALID_REQUEST");
    const requested: any = ctx.service.callTool("request_disclosure_grant", { session: "grant-session", rationale: "Writer needs one line.", path, roles: ["writer"], excerpts: [excerpt] });
    assert.equal(requested.ok, true);
    const shownGrant = await shown(ctx, "/inbox/requests/" + requested.result.request_id);
    assert.ok(shownGrant.html.includes(excerpt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")));
    assert.equal(ctx.service.activeGrants().length, 0);
    assert.equal((await decide(ctx, "approve", shownGrant.target, shownGrant.digest)).status, 200);
    const [grant] = ctx.service.activeGrants();
    assert.deepEqual([grant.grant.excerpts, grant.grant.roles, grant.grant.session], [[excerpt], ["writer"], "grant-session"]);
    const revoke = await shown(ctx, "/inbox/grants/" + grant.subject);
    assert.equal((await decide(ctx, "revoke", revoke.target, revoke.digest, { flags: 0x04 })).status, 409);
    assert.equal(ctx.service.activeGrants().length, 1);
    assert.equal((await decide(ctx, "revoke", revoke.target, revoke.digest)).status, 200);
    assert.equal(ctx.service.activeGrants().length, 0);
  } finally { await ctx.service.close(); }
});

test("editorial approval: workspace ASSET_APPROVED stays unverified; only a signed inbox approval flips run_status", async () => {
  const ctx = await owner("inbox-editorial");
  try {
    const requestId = propose(ctx.service, "editorial-session");
    const shownDirection = await shown(ctx, "/inbox/requests/" + requestId);
    assert.equal((await decide(ctx, "approve", shownDirection.target, shownDirection.digest)).status, 200);
    const job: any = ctx.service.callTool("run_start", { session: "editorial-session" });
    await waitFor(() => status(ctx.service, job.result.job_id)?.status === "complete");
    const runId = status(ctx.service, job.result.job_id).run_id;
    assert.equal(status(ctx.service, job.result.job_id).run.status, "WAITING_FOR_OWNER");
    const review = await shown(ctx, "/inbox/runs/" + job.result.job_id);
    assert.match(review.html, /Before the software, the stickers/);

    const db = new DatabaseSync(join(ctx.service.workspace, ".studio", "runs.sqlite"));
    db.prepare("UPDATE runs SET status = ? WHERE run_id = ?").run("ASSET_APPROVED", runId);
    assert.equal(status(ctx.service, job.result.job_id).run.status, "UNVERIFIED_WORKSPACE_STATUS");
    db.prepare("UPDATE runs SET status = ? WHERE run_id = ?").run("WAITING_FOR_OWNER", runId);
    db.close();

    // Draft bytes that no longer match the run's recorded digest are never shown or decided.
    const draft = join(ctx.service.workspace, ".studio", "artifacts", runId, "draft-v001.md"), original = readFileSync(draft);
    writeFileSync(draft, original.toString("utf8") + "\nAgent-added line.");
    const tamperedDigest = hash(readFileSync(draft));
    assert.match((await ctx.browser.get("/inbox/runs/" + job.result.job_id)).text, /do not match the recorded digest/);
    assert.equal((await ctx.browser.post("/inbox/api/challenge", { action: "approve_version", target: review.target, digest: tamperedDigest })).status, 409);
    writeFileSync(draft, original);
    // Draft bytes changed after the owner saw them: the shown digest no longer binds, so nothing is approved.
    const challenge = await ctx.browser.post("/inbox/api/challenge", { action: "approve_version", target: review.target, digest: review.digest });
    writeFileSync(draft, original.toString("utf8") + "\nAgent-added line.");
    assert.equal((await ctx.browser.post("/inbox/api/decide", { action: "approve_version", target: review.target, digest: review.digest, credential: ctx.auth.assert(challenge.body) })).status, 409);
    assert.equal(status(ctx.service, job.result.job_id).run.approval, null);
    writeFileSync(draft, original);

    assert.equal((await decide(ctx, "approve_version", review.target, review.digest)).status, 200);
    const approved = status(ctx.service, job.result.job_id).run;
    assert.equal(approved.status, "ASSET_APPROVED");
    assert.deepEqual(approved.approval, { version: "v001", digest: review.digest, signed: true });
    assert.equal(review.digest, hash(original));
    assert.equal((await ctx.browser.post("/inbox/api/challenge", { action: "revise", target: review.target, digest: review.digest })).status, 409, "a decided version cannot be decided again");
  } finally { await ctx.service.close(); }
});

test("owner setup code is single-use, short-lived and closes registration", async () => {
  const service = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-inbox-data-")), tenantId: "inbox-setup", workspace: sourceWorkspace() });
  try {
    const port = await service.listen(), browser = new Browser(port), auth = new VirtualAuthenticator("http://localhost:" + port);
    const code = service.ownerSetupCode()!;
    await browser.get("/inbox/setup");
    assert.equal((await browser.post("/inbox/api/register-options", { code: "wrong-code" })).status, 409);
    const options = await browser.post("/inbox/api/register-options", { code });
    assert.equal((await browser.post("/inbox/api/register", { code, credential: auth.register(options.body, { origin: "https://evil.example" }) })).status, 409);
    const retry = await browser.post("/inbox/api/register-options", { code });
    assert.equal((await browser.post("/inbox/api/register", { code, credential: auth.register(retry.body) })).status, 200);
    assert.equal((await browser.post("/inbox/api/register-options", { code })).status, 409);
    assert.equal(service.ownerSetupCode(), null);
    assert.match((await browser.get("/inbox/setup")).text, /Registration is closed/);
  } finally { await service.close(); }
});

test("REPRO A1: a signed approval of v001 is not approval of a later or edited draft", async () => {
  const verifier = new TestOwnerVerifier();
  const service = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-inbox-data-")), tenantId: "inbox-a1", workspace: sourceWorkspace(), ownerVerifier: verifier });
  try {
    const store = new AuthorityStore(service.tenantDir);
    for (const path of fixture.source_paths as string[]) { const digest = hash(readFileSync(join(service.workspace, path))); store.write("source_classification", sourceSubject(path, digest), { path, digest, visibility: "approved" }); }
    store.close();
    const pending: any = service.callTool("request_direction_approval", { session: "a1-session", rationale: "fixture", direction });
    service.ownerDecide("approve", pending.result.request_id, pending.result.digest, verifier.assertion());
    const job: any = service.callTool("run_start", { session: "a1-session" });
    await waitFor(() => status(service, job.result.job_id)?.status === "complete");
    const runId = status(service, job.result.job_id).run_id;
    const artifact = join(service.workspace, ".studio", "artifacts", runId), draft = join(artifact, "draft-v001.md"), v001 = readFileSync(draft);
    const approval = { action: "approve_version", target: `version-${runId}-v001`, digest: hash(v001) };
    service.ownerChannelForTesting().resolve(approval, verifier.assertion(), [{ kind: "editorial_approval", subject: runId, payload: { decision: "approve", run_id: runId, version: "v001", digest: approval.digest } }]);
    // Positive control: the genuine approval of the current version is reported as approved.
    assert.equal(status(service, job.result.job_id).run.status, "ASSET_APPROVED");
    assert.deepEqual(status(service, job.result.job_id).run.approval, { version: "v001", digest: approval.digest, signed: true });

    // Attack: point the unsigned snapshot at an unreviewed v002.
    const snapshotPath = join(artifact, "run-snapshot.json"), snapshot = readFileSync(snapshotPath);
    writeFileSync(join(artifact, "draft-v002.md"), "unreviewed attacker-controlled v002");
    writeFileSync(snapshotPath, JSON.stringify({ ...JSON.parse(snapshot.toString("utf8")), current_version: "v002", current_digest: hash("unreviewed attacker-controlled v002") }));
    assert.equal(status(service, job.result.job_id).run.status, "APPROVAL_NOT_CURRENT");
    assert.equal(status(service, job.result.job_id).run.approval, null);
    // Same version name, signed digest copied into the snapshot, but different bytes.
    writeFileSync(snapshotPath, JSON.stringify({ ...JSON.parse(snapshot.toString("utf8")), current_version: "v002", current_digest: approval.digest }));
    assert.equal(status(service, job.result.job_id).run.status, "APPROVAL_NOT_CURRENT");
    // Identical bytes under a different version name: the signature named v001, not v002.
    writeFileSync(join(artifact, "draft-v002.md"), v001);
    assert.equal(status(service, job.result.job_id).run.status, "APPROVAL_NOT_CURRENT");
    // The run's recorded digest disagrees with the signed one even though v001 bytes are untouched.
    writeFileSync(snapshotPath, JSON.stringify({ ...JSON.parse(snapshot.toString("utf8")), current_digest: hash("something else") }));
    assert.equal(status(service, job.result.job_id).run.status, "APPROVAL_NOT_CURRENT");
    // Snapshot untouched, v001 bytes edited in place.
    writeFileSync(snapshotPath, snapshot);
    writeFileSync(draft, v001.toString("utf8") + "\nAgent-added line.");
    assert.equal(status(service, job.result.job_id).run.status, "APPROVAL_NOT_CURRENT");
    writeFileSync(draft, v001);
    assert.equal(status(service, job.result.job_id).run.status, "ASSET_APPROVED");
  } finally { await service.close(); }
});

test("A2: wrong setup codes lock out only the guessing session, and the terminal can mint a fresh code", async () => {
  const service = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-inbox-data-")), tenantId: "inbox-a2", workspace: sourceWorkspace() });
  try {
    const port = await service.listen(), attacker = new Browser(port), auth = new VirtualAuthenticator("http://localhost:" + port);
    const code = service.ownerSetupCode()!;
    await attacker.get("/inbox/setup");
    for (let i = 0; i < 5; i++) assert.equal((await attacker.post("/inbox/api/register-options", { code: "wrong" })).status, 409);
    assert.equal((await attacker.post("/inbox/api/register-options", { code })).status, 409, "the guessing session is rate-limited even with the real code");
    // The owner's own session is unaffected (positive control).
    const ownerBrowser = new Browser(port);
    await ownerBrowser.get("/inbox/setup");
    assert.equal((await ownerBrowser.post("/inbox/api/register-options", { code })).status, 200);
    // The terminal mints a replacement without a restart; the old code stops working.
    const line = ownerConsoleLine(service, port, "setup"), fresh = /code within 10 minutes: ([A-Za-z0-9_-]+)\n$/.exec(line)?.[1];
    assert.ok(fresh && fresh !== code, line);
    assert.equal((await ownerBrowser.post("/inbox/api/register-options", { code })).status, 409);
    const options = await ownerBrowser.post("/inbox/api/register-options", { code: fresh });
    assert.equal(options.status, 200);
    assert.equal((await ownerBrowser.post("/inbox/api/register", { code: fresh, credential: auth.register(options.body) })).status, 200);
    assert.match(ownerConsoleLine(service, port, "setup"), /already registered/);
    assert.equal(ownerConsoleLine(service, port, ""), "");
  } finally { await service.close(); }
});

test("A3: registration stores the attested COSE key and refuses a different supplied key", async () => {
  const service = new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-inbox-data-")), tenantId: "inbox-a3", workspace: sourceWorkspace() });
  try {
    const port = await service.listen(), browser = new Browser(port), auth = new VirtualAuthenticator("http://localhost:" + port);
    const code = service.ownerSetupCode()!;
    await browser.get("/inbox/setup");
    const attempt = async (o: AssertOverrides) => browser.post("/inbox/api/register", { code, credential: auth.register((await browser.post("/inbox/api/register-options", { code })).body, o) });
    const foreign = await attempt({ foreignKey: true });
    assert.equal(foreign.status, 409);
    assert.match(foreign.body.error, /does not match the attested credential/);
    assert.equal((await attempt({ coseAlg: -8 })).status, 409, "a COSE key that is not ES256 is refused");
    assert.equal(service.passkeys!.credential(), null);
    assert.equal((await attempt({})).status, 200);
    assert.equal(service.passkeys!.credential()!.public_key, auth.keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"));
  } finally { await service.close(); }
});

/** A passkey tenant whose plan was approved in the inbox and whose two pieces are drafted and QA-clean, with a pending final request for piece 1. */
async function pieceFinalCtx(tenantId: string) {
  const ctx = await owner(tenantId);
  try { return await pieceFinalSetup(ctx, tenantId); } catch (error) { await ctx.service.close(); throw error; }
}
async function pieceFinalSetup(ctx: Ctx, tenantId: string) {
  const flow = new Flow(ctx.service).plan(tenantId + "-session", 2);
  const plan: any = flow.call("program_plan_submit_for_approval", { program_id: flow.program });
  const planPage = await shown(ctx, "/inbox/requests/" + plan.result.request_id);
  assert.equal((await decide(ctx, "approve", planPage.target, planPage.digest)).status, 200);
  for (const piece of flow.pieces) flow.draftPiece(piece.id);
  const request = (index: number) => flow.call("piece_final_request", { program_id: flow.program, piece_id: flow.pieces[index].id, document: flow.document(flow.pieces[index].id) }).result.request_id as string;
  return { ctx, flow, piece: flow.pieces[0].id, requestId: request(0), request };
}
const finalStatus = (flow: Flow, piece: string) => flow.status(piece);

test("passkey piece final: the inbox shows the exact draft and a valid assertion makes it final, authenticated, and not publish-eligible without more", async () => {
  const { ctx, flow, piece, requestId } = await pieceFinalCtx("inbox-piece-final");
  try {
    const page = await shown(ctx, "/inbox/requests/" + requestId);
    assert.match(page.html, /Finalize this exact piece version/);
    assert.match(page.html, /There is no result yet, and this issue will not pretend there is/, "the owner reads the draft bytes");
    assert.match(page.html, /Not publication, scheduling or any account change/);
    assert.notEqual(finalStatus(flow, piece).status, "final");
    const decided = await decide(ctx, "approve", page.target, page.digest);
    assert.equal(decided.status, 200, decided.text);
    const status = finalStatus(flow, piece);
    assert.deepEqual([status.status, status.final.policy, status.final.authenticated], ["final", "passkey", true]);
    const store = new AuthorityStore(ctx.service.tenantDir);
    try {
      const record = store.latest("piece_final", "piece-final-" + piece)!;
      assert.equal(record.destination, "private-editorial");
      assert.deepEqual((record.owner_binding as any).digest, page.digest, "the passkey challenge bound the shown digest");
      assert.match(String(record.owner_subject), /^passkey:/);
    } finally { store.close(); }
    assert.equal(ctx.service.publishGate(flow.program, piece, { destination: "newsletter:primary", digest: status.final.digest, document_revision: status.linear.document_revision }).allowed, false, "no destination authorization yet");
  } finally { await ctx.service.close(); }
});

const finalRefusals: [string, (ctx: Ctx, flow: Flow, target: string, digest: string, other: string) => Promise<Reply>][] = [
  ["wrong origin", (ctx, _flow, target, digest) => decide(ctx, "approve", target, digest, { origin: "http://127.0.0.1:" + ctx.port })],
  ["signature from another key", (ctx, _flow, target, digest) => decide(ctx, "approve", target, digest, { resign: true })],
  ["digest of different content", (ctx, _flow, target) => ctx.browser.post("/inbox/api/challenge", { action: "approve", target, digest: hash("some other draft") })],
  ["challenge issued for another piece's request", (ctx, _flow, target, digest, other) => decide(ctx, "approve", target, digest, {}, other)],
  ["replayed challenge", async (ctx, _flow, target, digest) => {
    const challenge = await ctx.browser.post("/inbox/api/challenge", { action: "approve", target, digest });
    const credential = ctx.auth.assert(challenge.body);
    assert.equal((await ctx.browser.post("/inbox/api/decide", { action: "reject", target, digest, credential })).status, 409, "an assertion for approve must not reject");
    return ctx.browser.post("/inbox/api/decide", { action: "approve", target, digest, credential });
  }],
];
for (const [name, attempt] of finalRefusals)
  test(`refused passkey piece final: ${name}; the piece stays non-final until a valid assertion`, async () => {
    const { ctx, flow, piece, requestId, request } = await pieceFinalCtx("inbox-final-" + name.replace(/[^a-z]+/g, "-").slice(0, 30).replace(/-$/, ""));
    try {
      const { target, digest } = await shown(ctx, "/inbox/requests/" + requestId);
      const refused = await attempt(ctx, flow, target, digest, request(1));
      assert.notEqual(refused.status, 200, refused.text);
      assert.notEqual(finalStatus(flow, piece).status, "final");
      const control = await decide(ctx, "approve", target, digest);
      assert.equal(control.status, 200, control.text);
      assert.equal(finalStatus(flow, piece).status, "final");
    } finally { await ctx.service.close(); }
  });

test("passkey piece final: editing the Linear document after the page was shown refuses the assertion; the re-reviewed version needs its own", async () => {
  const { ctx, flow, piece, requestId } = await pieceFinalCtx("inbox-final-edited");
  try {
    const shownBefore = await shown(ctx, "/inbox/requests/" + requestId);
    const input = flow.ingestOwnerEdit(piece, DRAFT + "\n\nAn owner edit made after the page was rendered.");
    const challenge = () => ctx.browser.post("/inbox/api/challenge", { action: "approve", target: shownBefore.target, digest: shownBefore.digest });
    const refused = await challenge();
    assert.equal(refused.status, 409, "no challenge is issued for content that changed: " + refused.text);
    assert.notEqual(finalStatus(flow, piece).status, "final");
    flow.reviseFromEdit(piece, input);
    assert.equal((await challenge()).status, 409, "the old page still describes the old version");
    const fresh = flow.call("piece_final_request", { program_id: flow.program, piece_id: piece, document: flow.document(piece) });
    const page = await shown(ctx, "/inbox/requests/" + fresh.result.request_id);
    assert.notEqual(page.digest, shownBefore.digest);
    assert.equal((await decide(ctx, "approve", page.target, page.digest)).status, 200);
    assert.equal(finalStatus(flow, piece).status, "final");
  } finally { await ctx.service.close(); }
});
