import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudioService } from "../src/service/studio-service.ts";
import { sourceWorkspace } from "./helpers/service-fixture.ts";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "proactive-repo-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.txt"), "hello");
  execSync("git add a.txt && git commit -m first", { cwd: dir, stdio: "ignore" });
  const sha = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
  return { dir, sha };
}

function makeBrokenRepo() {
  const dir = mkdtempSync(join(tmpdir(), "proactive-broken-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  // corrupt HEAD so git log fails, but keep .git dir
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/nope\n");
  return dir;
}

function makeWorktree() {
  const repo = makeRepo();
  const parent = mkdtempSync(join(tmpdir(), "proactive-worktree-parent-"));
  const dir = join(parent, "checkout");
  execFileSync("git", ["-C", repo.dir, "worktree", "add", "--detach", dir], { stdio: "ignore" });
  return { dir, sha: repo.sha };
}

function svc(watchedRepos: string[]) {
  return new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "proactive-data-")), tenantId: "proactive-tenant-" + Math.random().toString(36).slice(2), workspace: sourceWorkspace(), watchedRepos });
}

test("MCP tool list excludes idea_promote and idea_dismiss", () => {
  const s = svc([]);
  const names = s.listTools().map((t: any) => t.name);
  assert.ok(!names.includes("idea_promote"));
  assert.ok(!names.includes("idea_dismiss"));
  assert.equal(s.callTool("idea_promote", { id: "idea-000000000000" }).error, "DENIED");
});

test("promotion carries source_refs into pending direction", () => {
  const { dir, sha } = makeRepo();
  const s = svc([dir]);
  s.proactiveContext();
  const sub: any = s.ideaSubmit({ ideas: [{ kind: "content_idea", title: "t", rationale: "r", source_refs: [sha] }] });
  assert.equal(sub.ok, true);
  const ideaId = sub.result.accepted[0].id;
  const promoted: any = s.ideaPromote(ideaId);
  assert.equal(promoted.ok, true);
  const pending = s.pendingRequests()[0].request;
  const pendingDirection = pending.direction;
  assert.ok(pendingDirection);
  assert.deepEqual(pendingDirection.source_refs, [sha]);
  assert.ok(!JSON.stringify(pending.direction).includes("sources/proactive-idea.md"));
});

test("MCP direction requests cannot supply proactive source_refs", () => {
  const s = svc([]);
  const out = s.callTool("request_direction_approval", {
    session: "mcp-ref-test",
    rationale: "fixture",
    direction: {
      idea: "idea",
      audience: "audience",
      source_paths: [],
      source_refs: ["not-a-digest-ref"],
      reader_question: "question",
      angle: "angle",
      reader_promise: "promise",
      exclusions: [],
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, "INVALID_REQUEST");
});

test("cursor advancement is all-or-nothing", () => {
  const { dir, sha } = makeRepo();
  const s = svc([dir]);
  s.proactiveContext();
  const bad: any = s.ideaSubmit({ ideas: [{ kind: "content_idea", title: "t", rationale: "r", source_refs: [sha] }, { kind: "content_idea", title: "u", rationale: "r", source_refs: ["deadbeef"] }] });
  assert.equal(bad.result.cursor_advanced, false);
  assert.ok(existsSync(join(s.tenantDir, "proactive-pending-cursor.json")));
  const good: any = s.ideaSubmit({ ideas: [{ kind: "content_idea", title: "t", rationale: "r", source_refs: [sha] }] });
  assert.equal(good.result.cursor_advanced, true);
  assert.ok(!existsSync(join(s.tenantDir, "proactive-pending-cursor.json")));
});

test("empty submission advances cursor", () => {
  const { dir } = makeRepo();
  const s = svc([dir]);
  s.proactiveContext();
  const res: any = s.ideaSubmit({ ideas: [] });
  assert.equal(res.ok, true);
  assert.equal(res.result.cursor_advanced, true);
});

test("broken repo does not advance cursor", () => {
  const { dir, sha } = makeRepo();
  const broken = makeBrokenRepo();
  const s = svc([dir, broken]);
  const ctx: any = s.proactiveContext();
  const brokenRepo = ctx.result.repos.find((r: any) => r.error);
  assert.ok(brokenRepo);
  const brokenPath = brokenRepo.path;
  assert.equal(ctx.result.next_cursor[brokenPath], null);
  const sub: any = s.ideaSubmit({ ideas: [{ kind: "content_idea", title: "t", rationale: "r", source_refs: [sha] }] });
  assert.equal(sub.result.cursor_advanced, true);
  // broken repo cursor must not advance (verified via next_cursor above)
});

test("digest refs consumed on success", () => {
  const { dir, sha } = makeRepo();
  const s = svc([dir]);
  s.proactiveContext();
  const first: any = s.ideaSubmit({ ideas: [{ kind: "content_idea", title: "t", rationale: "r", source_refs: [sha] }] });
  assert.equal(first.result.cursor_advanced, true);
  const second: any = s.ideaSubmit({ ideas: [{ kind: "content_idea", title: "t", rationale: "r", source_refs: [sha] }] });
  assert.equal(second.result.accepted.length, 0);
  assert.ok(second.result.rejected.some((r: any) => r.error === "NO_DIGEST" || r.error === "SOURCE_REF_NOT_IN_DIGEST"));
});

test("digest refs retained after rejection", () => {
  const { dir, sha } = makeRepo();
  const s = svc([dir]);
  s.proactiveContext();
  const bad: any = s.ideaSubmit({ ideas: [{ kind: "content_idea", title: "t", rationale: "r", source_refs: ["deadbeef"] }] });
  assert.equal(bad.result.cursor_advanced, false);
  const retry: any = s.ideaSubmit({ ideas: [{ kind: "content_idea", title: "t", rationale: "r", source_refs: [sha] }] });
  assert.equal(retry.result.accepted.length, 1);
});

test("normal git worktree is watchable and produces a bounded digest", () => {
  const { dir, sha } = makeWorktree();
  const s = svc([dir]);
  const ctx: any = s.proactiveContext();
  assert.equal(ctx.ok, true);
  assert.equal(ctx.result.repos[0].error, null);
  assert.equal(ctx.result.repos[0].commits[0].sha, sha);
  assert.ok(ctx.result.repos[0].commits.length > 0 && ctx.result.repos[0].commits.length <= 50);
});

test("watched repo validation rejects symlink, .., external gitdir", () => {
  const { dir } = makeRepo();
  const dataRoot = mkdtempSync(join(tmpdir(), "proactive-data-"));
  const s = (repos: string[]) => new StudioService({ dataRoot, tenantId: "vr", workspace: sourceWorkspace(), watchedRepos: repos });
  // symlink
  const link = join(tmpdir(), "proactive-link-" + Math.random());
  try { rmSync(link, { recursive: true, force: true }); } catch {}
  symlinkSync(dir, link);
  assert.throws(() => s([link]));
  // .. segment
  assert.throws(() => s([dir + "/../x"]));
  // data-root nesting
  const nested = join(dataRoot, "nested-repo");
  execFileSync("git", ["clone", dir, nested], { stdio: "ignore" });
  assert.throws(() => s([nested]));
  // external gitdir file
  const wt = mkdtempSync(join(tmpdir(), "proactive-wt-"));
  execSync("git init", { cwd: wt, stdio: "ignore" });
  // make .git a file pointing outside
  rmSync(join(wt, ".git"), { recursive: true, force: true });
  writeFileSync(join(wt, ".git"), "gitdir: /tmp/external-gitdir\n");
  assert.throws(() => s([wt]));
  // a relative .git file must not escape through a symlinked gitdir component
  const external = mkdtempSync(join(tmpdir(), "proactive-external-"));
  execSync("git init", { cwd: external, stdio: "ignore" });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(external, ".git")}\n`);
  assert.throws(() => s([wt]));
  // A valid external Git directory is still not a standard worktree entry.
  symlinkSync(join(external, ".git"), join(wt, "internal-gitdir"));
  writeFileSync(join(wt, ".git"), "gitdir: internal-gitdir\n");
  assert.throws(() => s([wt]));
});

test("promotion only when open and idempotent", () => {
  const { dir, sha } = makeRepo();
  const s = svc([dir]);
  s.proactiveContext();
  const sub: any = s.ideaSubmit({ ideas: [
    { kind: "content_idea", title: "t", rationale: "r", source_refs: [sha] },
    { kind: "content_idea", title: "u", rationale: "r", source_refs: [sha] },
  ] });
  const ideaId = sub.result.accepted[0].id;
  const id2 = sub.result.accepted[1].id;
  const p1: any = s.ideaPromote(ideaId);
  assert.equal(p1.ok, true);
  const p2: any = s.ideaPromote(ideaId);
  assert.equal(p2.ok, true);
  assert.equal(p2.result.request_id, p1.result.request_id);
  assert.equal(s.pendingRequests().length, 1);
  // dismissed idea not promotable
  s.ideaDismiss(id2);
  const p3: any = s.ideaPromote(id2);
  assert.equal(p3.ok, false);
});
