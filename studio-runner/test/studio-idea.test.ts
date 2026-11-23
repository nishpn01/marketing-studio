import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudioService } from "../src/service/studio-service.ts";
import { REPO_ROOT } from "../src/runner.ts";
import { sourceWorkspace } from "./helpers/service-fixture.ts";

const skillText = readFileSync(join(REPO_ROOT, "hosts/claude-code/studio-idea/SKILL.md"), "utf8");
const svc = () => new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-idea-data-")), tenantId: "idea-tenant", workspace: sourceWorkspace() });

test("studio-idea names idea_submit as its only Studio tool and is mirrored for Codex", () => {
  const s = svc();
  const tools = s.listTools().map((t: { name: string }) => t.name);
  const used = tools.filter((name: string) => new RegExp(`\\b${name}\\b`).test(skillText));
  assert.deepEqual(used, ["idea_submit"]);
  assert.equal(readFileSync(join(REPO_ROOT, ".agents/skills/studio-idea/SKILL.md"), "utf8"), skillText);
  assert.match(skillText, /^---\nname: studio-idea\ndescription:/);
  assert.match(skillText, /\/marketing-director/);
  assert.match(skillText, /open my latest idea/);
  assert.ok(!/Bearer/.test(skillText));
});

test("the skill's own idea_submit example is accepted, saves nothing else, and lands in ideas_list", () => {
  const example = skillText.match(/idea_submit once: (\{.*?\}\]\})\./)?.[1];
  assert.ok(example, "example call present");
  const args = JSON.parse(example!);
  args.ideas[0].title = "Newsletter on the site rebuild";
  args.ideas[0].rationale = "Why now: launch is next week.";
  const s = svc();
  const out: any = s.callTool("idea_submit", args);
  assert.equal(out.ok, true);
  assert.equal(out.result.accepted.length, 1);
  assert.equal(out.result.accepted[0].origin, "owner_chat");
  assert.equal(out.result.cursor_advanced, false);
  assert.deepEqual((s.callTool("ideas_list", {}).result as any).ideas.map((i: any) => i.title), ["Newsletter on the site rebuild"]);
  // same capture again is deduped, not duplicated
  assert.equal((s.callTool("idea_submit", args) as any).result.deduped.length, 1);
});

test("scan ideas still need digest refs and an unknown origin is rejected", () => {
  const s = svc();
  const scan: any = s.callTool("idea_submit", { ideas: [{ kind: "content_idea", title: "t", rationale: "r", source_refs: ["deadbeef"] }] });
  assert.equal(scan.result.rejected[0].error, "NO_DIGEST");
  const odd: any = s.callTool("idea_submit", { ideas: [{ kind: "content_idea", origin: "scan", title: "t", rationale: "r", source_refs: ["x"] }] });
  assert.equal(odd.result.rejected[0].error, "INVALID_ORIGIN");
});

/** A watched git repo with one commit; returns its path and HEAD sha. */
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "studio-idea-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"]);
  return { dir, sha: execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}
function watching(dir: string) {
  return new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-idea-data-")), tenantId: "idea-tenant", workspace: sourceWorkspace(), watchedRepos: [dir] });
}

test("owner_chat capture leaves a pending scan cursor and the proactive digest untouched", () => {
  const { dir, sha } = gitRepo();
  const s = watching(dir);
  s.proactiveContext();
  const pending = join(s.tenantDir, "proactive-pending-cursor.json");
  const digest = join(s.tenantDir, "proactive-digest-refs.json");
  const pendingBefore = readFileSync(pending, "utf8");
  const digestBefore = readFileSync(digest, "utf8");
  const chat: any = s.callTool("idea_submit", { ideas: [{ kind: "content_idea", origin: "owner_chat", title: "chat idea", rationale: "r", source_refs: ["chat:web"] }] });
  assert.equal(chat.result.accepted.length, 1);
  assert.equal(chat.result.cursor_advanced, false);
  assert.equal(readFileSync(pending, "utf8"), pendingBefore);
  assert.equal(readFileSync(digest, "utf8"), digestBefore);
  assert.ok(!existsSync(join(s.tenantDir, "proactive-cursor.json")));
  // the scan's digest is still there to be submitted afterwards
  const scan: any = s.callTool("idea_submit", { ideas: [{ kind: "content_idea", title: "scan idea", rationale: "r", source_refs: [sha] }] });
  assert.equal(scan.result.accepted.length, 1);
  assert.equal(scan.result.cursor_advanced, true);
});

test("a scan idea and an owner_chat idea with the same title and refs stay two ideas", () => {
  const { dir, sha } = gitRepo();
  const s = watching(dir);
  s.proactiveContext();
  const idea = { kind: "content_idea", title: "Launch recap", rationale: "Why now: launch.", source_refs: [sha] };
  const scan: any = s.callTool("idea_submit", { ideas: [idea] });
  assert.equal(scan.result.accepted.length, 1);
  const chat: any = s.callTool("idea_submit", { ideas: [{ ...idea, origin: "owner_chat" }] });
  assert.equal(chat.result.accepted.length, 1);
  assert.equal(chat.result.deduped.length, 0);
  assert.equal((s.callTool("ideas_list", {}).result as any).ideas.length, 2);
});

function userInstall(path: string, home: string) {
  const root = mkdtempSync(join(tmpdir(), "studio-user-ws-"));
  writeFileSync(join(root, "studio-business.json"), "{}\n");
  return spawnSync("sh", [join(REPO_ROOT, "hosts/claude-code/install.sh"), "--user", "demo", root], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: path, STUDIO_PORT: "8123" } });
}
function seededHome() {
  const home = mkdtempSync(join(tmpdir(), "studio-user-home-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ model: "keep-me", permissions: { allow: ["Bash(ls*)"] } }));
  return home;
}
function assertUserFiles(home: string) {
  for (const skill of ["marketing-director", "marketing-director-cli", "studio-idea"]) assert.ok(existsSync(join(home, ".claude/skills", skill, "SKILL.md")), skill);
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  assert.equal(settings.model, "keep-me");
  assert.ok(settings.permissions.allow.includes("Bash(ls*)"));
}

test("install.sh --user installs skills under $HOME and registers user scope without a literal token", () => {
  const home = seededHome();
  const bin = mkdtempSync(join(tmpdir(), "studio-fake-claude-"));
  const log = join(bin, "argv.log");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> '${log}'\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const r = userInstall(`${bin}:/usr/bin:/bin:${process.env.PATH}`, home);
  assert.equal(r.status, 0, r.stderr);
  assertUserFiles(home);
  const calls = readFileSync(log, "utf8");
  assert.match(calls, /mcp add --scope user --transport http marketing-studio http:\/\/127\.0\.0\.1:8123\/mcp --header Authorization: Bearer \$\{STUDIO_TOKEN\}/);
  assert.ok(!existsSync(join(home, ".mcp.json")));
});

test("install.sh --user with the real claude CLI merges into a temp HOME's user config", { skip: spawnSync("claude", ["--version"]).status !== 0 }, () => {
  const home = seededHome();
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { other: { type: "http", url: "http://x" } } }));
  for (let run = 0; run < 2; run++) {
    const r = userInstall(process.env.PATH!, home);
    assert.equal(r.status, 0, r.stderr);
  }
  assertUserFiles(home);
  const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.deepEqual(cfg.mcpServers.other, { type: "http", url: "http://x" });
  assert.deepEqual(cfg.mcpServers["marketing-studio"], { type: "http", url: "http://127.0.0.1:8123/mcp", headers: { Authorization: "Bearer ${STUDIO_TOKEN}" } });
});
