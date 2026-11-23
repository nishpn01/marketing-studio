import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaults, gitArgv, main, paths, planInstall, planUninstall, plist, realFs, realSys, selfCheck, verify, type Fs, type Options, type Sys } from "../src/separate-user-install.ts";

const OWNER_UID = 501, SVC_UID = 399;
const SHA = "a".repeat(40);
const OURS = { RealName: "Marketing Studio Service", UserShell: "/usr/bin/false", NFSHomeDirectory: "/Library/MarketingStudio/home", Password: "*", IsHidden: "1" };
const MARKER_TEXT = "marketing-studio-core separate-user install\nuser=_studio\n";
const base: Options = { ...defaults({ SUDO_USER: "alice" }), owner: "alice", node: "/usr/local/bin/node", source: "/src/core", provider: "claude-code-cli" };
const NODE_ARGS = ["--owner", "alice", "--node", "/usr/local/bin/node", "--source", "/src/core"];

type Over = { users?: string[]; nodeStat?: { uid: number; mode: number }; git?: boolean; loaded?: boolean; attrs?: Record<string, string>; admin?: string; marker?: string | null; acl?: string; head?: string; bootoutFails?: boolean };
/** Mocked machine: records every state-changing call, answers probes from `over`. Nothing real is touched. */
function fakeSys(over: Over = {}) {
  const calls: string[][] = [], writes: string[] = [], probes: string[][] = [];
  const attrs = { ...OURS, ...over.attrs };
  const sys: Sys = {
    probe: (argv) => {
      const j = argv.join(" ");
      probes.push(argv);
      if (j.includes(" ls-remote ")) return over.git === false ? { status: 128, stdout: "" } : { status: 0, stdout: (over.head ?? SHA) + "\tHEAD\n" };
      if (j.includes("rev-parse --verify FETCH_HEAD")) return { status: 0, stdout: (over.head ?? SHA) + "\n" };
      if (j.includes("-read /Users/_studio UniqueID")) return { status: over.users?.includes("user") ? 0 : 1, stdout: "UniqueID: 350\n" };
      const attr = j.match(/-read \/Users\/_studio (\w+)$/);
      if (attr) return { status: 0, stdout: attr[1] === "RealName" ? "RealName:\n " + attrs.RealName + "\n" : `${attr[1]}: ${attrs[attr[1] as keyof typeof attrs]}\n` };
      if (j.includes("-read /Groups/admin")) return { status: 0, stdout: "GroupMembership: root " + (over.admin ?? "alice") + "\n" };
      if (j.includes("-read /Groups/_studio")) return { status: over.users?.includes("group") ? 0 : 1, stdout: "PrimaryGroupID: 350\n" };
      if (j.includes("-list /Users")) return { status: 0, stdout: "root 0\nalice 501\n_foo 300\n" };
      if (j.includes("-list /Groups")) return { status: 0, stdout: "wheel 0\n_bar 301\n" };
      if (j.startsWith("launchctl print")) return { status: over.loaded ? 0 : 1, stdout: "" };
      if (j.startsWith("ls -lde")) return { status: 0, stdout: over.acl ?? "drwxr-xr-x  3 root  wheel  96 Jan  1 00:00 /x\n" };
      return { status: 1, stdout: "" };
    },
    exec: (argv) => { calls.push(argv); return over.bootoutFails && argv[1] === "bootout" ? 1 : 0; },
    read: (p) => (p.endsWith("/.marketing-studio-install") ? (over.marker === undefined ? MARKER_TEXT : over.marker) : null),
    write: (p) => { writes.push(p); },
    stat: () => over.nodeStat ?? { uid: 0, mode: 0o40755 },
    realpath: (p) => p,
  };
  return { sys, calls, writes, probes };
}
const lines = (f: (out: (l: string) => void) => unknown) => { const o: string[] = []; f((l) => o.push(l)); return o.join("\n"); };
const argvs = (steps: { argv?: string[] }[]) => steps.flatMap((s) => (s.argv ? [s.argv.join(" ")] : []));

test("dry-run prints every command and executes nothing, and names the commit the real run must pin", () => {
  const { sys, calls, writes } = fakeSys();
  const out = lines((out) => assert.equal(main(["install", "--dry-run", ...NODE_ARGS, "--provider", "claude-code-cli"], sys, realFs(), false, out), 0));
  assert.deepEqual(calls, []);
  assert.deepEqual(writes, []);
  for (const needle of ["$ dscl . -create /Users/_studio UniqueID 302", "$ dscl . -create /Groups/_studio PrimaryGroupID 302", "UserShell /usr/bin/false", "IsHidden 1", "$ install -d -m 0700 -o _studio -g _studio /Library/MarketingStudio/data /Library/MarketingStudio/home", "fetch --quiet --no-tags --no-recurse-submodules /src/core " + SHA, "verify the fetched commit", "init --quiet --template= /Library/MarketingStudio/code.new", "$ launchctl bootstrap system /Library/LaunchDaemons/com.marketing-studio.service.plist", "<key>UserName</key><string>_studio</string>", "STUDIO_PROVIDER</key><string>claude-code-cli", `must say --commit ${SHA}`, "Dry run: nothing was changed."])
    assert.ok(out.includes(needle), needle);
});

test("a real install needs --commit, and without root refuses before running anything", () => {
  const { sys, calls } = fakeSys();
  assert.throws(() => main(["install", ...NODE_ARGS], sys, realFs(), true, () => {}), /needs --commit/);
  const out = lines((out) => assert.equal(main(["install", ...NODE_ARGS, "--commit", SHA], sys, realFs(), false, out), 2));
  assert.deepEqual(calls, []);
  assert.match(out, /sudo/);
});

test("--commit pins the reviewed commit: a fetched commit that is not it, or a malformed sha, is refused, the matching one installs", () => {
  // The source is never asked what its HEAD is once --commit is given; the fetched commit is what gets compared.
  const moved = fakeSys({ head: "b".repeat(40) });
  assert.throws(() => main(["install", ...NODE_ARGS, "--commit", SHA], moved.sys, realFs(), true, () => {}), /Verification failed: verify the fetched commit is exactly --commit/);
  assert.ok(!moved.calls.some((c) => c.includes("checkout")), "nothing is checked out after a failed verification");
  // Even a dry-run run as root must not ask the owner's checkout for its HEAD.
  assert.throws(() => main(["install", "--dry-run", ...NODE_ARGS], fakeSys().sys, realFs(), true, () => {}), /needs --commit/);
  assert.throws(() => planInstall({ ...base, commit: "abc123" }, fakeSys().sys), /Invalid --commit/);
  assert.throws(() => planInstall({ ...base, commit: SHA.toUpperCase() }, fakeSys().sys), /Invalid --commit/);
  const steps = planInstall({ ...base, commit: SHA }, fakeSys().sys);
  assert.ok(argvs(steps).some((a) => a.endsWith("checkout --quiet --detach " + SHA)));
});

test("--self-check refuses to run as root from files the owner can write, and passes from root-owned ones", () => {
  assert.throws(() => main(["install", "--dry-run", ...NODE_ARGS, "--self-check"], fakeSys({ nodeStat: { uid: OWNER_UID, mode: 0o40755 } }).sys, realFs(), false, () => {}), /--self-check.*root-owned copy/);
  assert.throws(() => main(["install", "--dry-run", ...NODE_ARGS, "--self-check"], fakeSys({ nodeStat: { uid: 0, mode: 0o40775 } }).sys, realFs(), false, () => {}), /--self-check/);
  assert.doesNotThrow(() => selfCheck(fakeSys().sys, ["/opt/studio-install/studio-runner/src/separate-user-install.ts"]));
  // The default file list includes the node running the installer: an owner-writable node is refused even if the scripts are fine.
  const runningNode = realpathSync(process.execPath), real = fakeSys().sys;
  assert.doesNotThrow(() => selfCheck(real));
  assert.throws(() => selfCheck({ ...real, stat: (p) => (p === runningNode ? { uid: OWNER_UID, mode: 0o100755 } : { uid: 0, mode: 0o40755 }) }), new RegExp(runningNode.replace(/\//g, "\\/")));
  assert.throws(() => selfCheck(fakeSys({ nodeStat: { uid: OWNER_UID, mode: 0o40755 } }).sys, ["/x/y.ts"]), /not root-owned/);
});

test("as root the plan runs in order, stops a loaded daemon first and tolerates no failure there", () => {
  const { sys, calls, writes } = fakeSys({ loaded: true });
  assert.equal(main(["install", ...NODE_ARGS, "--commit", SHA], sys, realFs(), true, () => {}), 0);
  assert.deepEqual(writes, ["/Library/MarketingStudio/.marketing-studio-install", "/Library/LaunchDaemons/com.marketing-studio.service.plist"]);
  assert.deepEqual(calls[0], ["launchctl", "bootout", "system/com.marketing-studio.service"]);
  assert.deepEqual(calls.at(-1), ["launchctl", "bootstrap", "system", "/Library/LaunchDaemons/com.marketing-studio.service.plist"]);
  // L2: a daemon that refuses to stop must stop the plan before any code is swapped.
  const stuck = fakeSys({ loaded: true, bootoutFails: true });
  assert.throws(() => main(["install", ...NODE_ARGS, "--commit", SHA], stuck.sys, realFs(), true, () => {}), /Step failed: launchctl bootout/);
  assert.deepEqual(stuck.calls, [["launchctl", "bootout", "system/com.marketing-studio.service"]]);
  // Not loaded: nothing to stop.
  assert.ok(!argvs(planInstall(base, fakeSys().sys)).some((a) => a.includes("bootout")));
  const failing = { ...sys, exec: (a: string[]) => (a[0] === "install" ? 1 : 0) };
  assert.throws(() => main(["install", ...NODE_ARGS, "--commit", SHA], failing, realFs(), true, () => {}), /Step failed: install/);
});

test("the plan sets the permissions that matter: 0755 root state, 0700 data/home, root:wheel 0644 plist, no go-w on the code, no password", () => {
  const steps = planInstall(base, fakeSys().sys), a = argvs(steps);
  assert.ok(a.includes("install -d -m 0755 -o root -g wheel /Library/MarketingStudio"));
  assert.ok(a.includes("chmod -R go-w /Library/MarketingStudio/code.new"));
  assert.ok(a.includes("chown root:wheel /Library/LaunchDaemons/com.marketing-studio.service.plist"));
  assert.ok(a.includes("dscl . -create /Users/_studio Password *"));
  assert.equal(steps.find((s) => s.write?.path.endsWith(".plist"))!.write!.mode, 0o644);
  assert.ok(!a.some((x) => x.includes("safe.directory")), "no git step overrides git's ownership protection");
  for (const g of a.filter((x) => x.includes("git"))) assert.match(g, /^env -i HOME=\/var\/empty GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=\/dev\/null PATH=\S+ (SUDO_UID=\d+ )?\/usr\/bin\/git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -c submodule\.recurse=false /);
  const text = plist(base);
  assert.match(text, /GIT_CONFIG_KEY_0<\/key><string>safe.directory/, "the daemon trusts only its own root-owned clone for the skill-pin checks");
  assert.ok(a.indexOf(a.find((x) => x.includes("rm -rf /Library/MarketingStudio/code.new"))!) < a.indexOf("mv /Library/MarketingStudio/code.new /Library/MarketingStudio/code"));
});

test("install is idempotent: an existing complete user and group are not touched, and the rest of the plan is identical", () => {
  const fresh = planInstall(base, fakeSys().sys), again = planInstall(base, fakeSys({ users: ["user", "group"] }).sys);
  assert.ok(fresh.some((s) => s.argv?.[0] === "dscl"));
  assert.ok(!again.some((s) => s.argv?.[0] === "dscl"));
  assert.deepEqual(again, fresh.filter((s) => s.argv?.[0] !== "dscl"));
  assert.deepEqual(planInstall(base, fakeSys().sys), fresh);
  // A leftover group without the user reuses that group id.
  const partial = planInstall(base, fakeSys({ users: ["group"] }).sys);
  assert.ok(partial.some((s) => s.argv?.join(" ") === "dscl . -create /Users/_studio UniqueID 350"));
  assert.ok(!partial.some((s) => s.argv?.join(" ").includes("-create /Groups/_studio")));
});

test("an existing user is verified, not trusted: foreign or admin accounts are refused, a half-finished earlier run is repaired", () => {
  const users = ["user", "group"];
  assert.throws(() => planInstall(base, fakeSys({ users, attrs: { RealName: "World Wide Web Server" } }).sys), /not the Marketing Studio Service user/);
  assert.throws(() => planInstall(base, fakeSys({ users, admin: "_studio" }).sys), /in the admin group/);
  // The first run died after UniqueID: no hidden flag, default shell, no locked password. The rerun re-asserts exactly those.
  const repair = argvs(planInstall(base, fakeSys({ users, attrs: { IsHidden: "", UserShell: "/bin/zsh", Password: "********" } }).sys)).filter((a) => a.startsWith("dscl"));
  assert.deepEqual(repair, ["dscl . -create /Users/_studio UserShell /usr/bin/false", "dscl . -create /Users/_studio Password *", "dscl . -create /Users/_studio IsHidden 1"]);
  assert.deepEqual(argvs(planInstall(base, fakeSys({ users, attrs: { NFSHomeDirectory: "/Users/alice" } }).sys)).filter((a) => a.startsWith("dscl")), ["dscl . -create /Users/_studio NFSHomeDirectory /Library/MarketingStudio/home"]);
});

test("refuses a node binary or ancestor the owner can write (mode or ACL) and a non-git source", () => {
  assert.throws(() => planInstall(base, fakeSys({ nodeStat: { uid: OWNER_UID, mode: 0o40755 } }).sys), /not root-owned/);
  assert.throws(() => planInstall(base, fakeSys({ nodeStat: { uid: 0, mode: 0o40775 } }).sys), /writable by a non-root user/);
  assert.throws(() => planInstall(base, fakeSys({ git: false }).sys), /not a git repository/);
  // L2: root-owned 0755 but group:admin may write through an ACL.
  const acl = "drwxr-xr-x+ 3 root  wheel  96 Jan  1 00:00 /usr/local\n 0: group:admin allow list,add_file,search,add_subdirectory,delete_child\n";
  assert.throws(() => planInstall(base, fakeSys({ acl }).sys), /ACL/);
  const deny = "drwxr-xr-x+ 3 root  wheel  96 Jan  1 00:00 /Library\n 0: group:everyone deny delete\n";
  assert.doesNotThrow(() => planInstall(base, fakeSys({ acl: deny }).sys));
});

test("rejects option values that could smuggle shell or XML or point the deletes outside our footprint", () => {
  const bad: Partial<Options>[] = [{ owner: "root" }, { owner: "a b" }, { owner: "_studio" }, { user: "studio" }, { port: 80 }, { provider: "gpt" }, { base: "/Library/x y" }, { base: "/a/../b" }, { tenant: "A" },
    { base: "/Users/alice" }, { base: "/" }, { base: "/Library" }, { base: "/opt" }, { base: "/Library/../Users/alice" }, { base: "/tmp/x" },
    { label: "../../../tmp/x" }, { label: "a b" }, { label: "" }, { label: "x/y" }, { plistDir: "/tmp" }, { plistDir: "/Library/../tmp" }];
  for (const b of bad) {
    assert.throws(() => planInstall({ ...base, ...b }, fakeSys().sys), /Invalid/, JSON.stringify(b));
    assert.throws(() => planUninstall({ ...base, ...b }, fakeSys().sys), /Invalid/, JSON.stringify(b));
  }
  // The reviewer's repro: purge pointed at the owner's home with a system user and a traversing label.
  assert.throws(() => main(["uninstall", "--purge", "--dry-run", "--base", "/Users/alice", "--user", "_www", "--label", "../../../tmp/x", "--owner", "alice"], fakeSys().sys, realFs(), false, () => {}), /Invalid/);
  assert.doesNotThrow(() => planInstall({ ...base, base: "/opt/studio-x" }, fakeSys().sys));
});

test("the launchd job runs as the service user, with the code and data outside the owner's reach", () => {
  const text = plist(base), d = paths(base);
  assert.match(text, /<key>UserName<\/key><string>_studio</);
  assert.match(text, new RegExp(`${d.code}/studio-runner/bin/studio-daemon`));
  assert.ok(!text.includes("/Users/alice"), "no owner home in the daemon environment");
  assert.ok(!/STUDIO_ALLOW_ENV_OVERRIDES|ANTHROPIC_API_KEY/.test(text));
});

test("uninstall keeps data and the user unless --purge, and purge deletes our user and data only after checking they are ours", () => {
  const users = ["user", "group"];
  const keep = planUninstall(base, fakeSys({ users }).sys).flatMap((s) => s.argv ?? []).join(" ");
  assert.ok(!/ data| home|-delete/.test(keep));
  const purge = argvs(planUninstall({ ...base, purge: true }, fakeSys({ users }).sys));
  assert.ok(purge.includes("rm -rf /Library/MarketingStudio/data /Library/MarketingStudio/home /Library/MarketingStudio/public"));
  assert.ok(purge.includes("dscl . -delete /Users/_studio") && purge.includes("dscl . -delete /Groups/_studio"));
  assert.deepEqual(planUninstall(base, fakeSys().sys), planUninstall(base, fakeSys().sys));
  // M4: before any rm -rf or dscl -delete.
  assert.throws(() => planUninstall({ ...base, purge: true }, fakeSys({ users, attrs: { RealName: "World Wide Web Server" } }).sys), /Refusing to delete \/Users\/_studio/);
  assert.throws(() => planUninstall({ ...base, purge: true }, fakeSys({ users, attrs: { NFSHomeDirectory: "/var/empty" } }).sys), /Refusing to delete \/Users\/_studio/);
  assert.throws(() => planUninstall(base, fakeSys({ marker: null }).sys), /not a Marketing Studio install/);
  assert.throws(() => planUninstall(base, fakeSys({ marker: "user=_other\n" }).sys), /not a Marketing Studio install/);
  assert.throws(() => planUninstall({ ...base, user: "_other" }, fakeSys().sys), /not a Marketing Studio install/);
  const order = argvs(planUninstall({ ...base, purge: true }, fakeSys({ users }).sys));
  assert.ok(order.indexOf("rm -f /Library/MarketingStudio/.marketing-studio-install") < order.indexOf("rmdir /Library/MarketingStudio"));
});

test("N1: with --commit the installer runs no git command in, or aimed at, the owner's checkout except the one fetch by sha", () => {
  const f = fakeSys(), steps = planInstall({ ...base, commit: SHA }, f.sys);
  assert.deepEqual(f.probes.filter((a) => a.some((x) => x.includes("git"))), [], "planning probes git not at all");
  const touching = argvs(steps).filter((a) => a.includes(base.source));
  assert.equal(touching.length, 1);
  assert.match(touching[0], new RegExp(` -c protocol\\.file\\.allow=always fetch --quiet --no-tags --no-recurse-submodules ${base.source} ${SHA}$`));
  for (const a of argvs(steps).filter((x) => x.includes("git") && !x.includes(" ls-remote "))) assert.ok(!/ status | config | rev-parse HEAD/.test(a) && !a.includes("-C " + base.source), a);
  // The dry-run's sha comes from the same fetch path (ls-remote), pinned away from the working directory, and only while no --commit is given.
  const dry = fakeSys(); planInstall(base, dry.sys);
  assert.equal(dry.probes.filter((a) => a.some((x) => x.includes("git"))).length, 1);
  assert.match(dry.probes.find((a) => a.includes("ls-remote"))!.join(" "), / -C \/ -c protocol\.file\.allow=always ls-remote \/src\/core HEAD$/);
});

/** A real repo whose ONLY danger is a clean filter named `evil`, reached through one config route. Dirty so `git status` would run it. */
type Route = (ctx: { src: string; dir: string; filter: string; sh: (cwd: string, ...a: string[]) => string }) => void;
const ROUTES: Record<string, Route> = {
  "direct filter.* in .git/config": ({ src, filter, sh }) => sh(src, "config", "filter.evil.clean", filter),
  "include.path": ({ src, dir, filter, sh }) => { writeFileSync(join(dir, "extra.cfg"), `[filter "evil"]\n\tclean = ${filter}\n`); sh(src, "config", "include.path", join(dir, "extra.cfg")); },
  "includeIf.gitdir": ({ src, dir, filter, sh }) => { writeFileSync(join(dir, "extra.cfg"), `[filter "evil"]\n\tclean = ${filter}\n`); sh(src, "config", `includeIf.gitdir:${realpathSync(src)}/.git.path`, join(dir, "extra.cfg")); },
  "extensions.worktreeConfig": ({ src, filter, sh }) => { sh(src, "config", "extensions.worktreeConfig", "true"); writeFileSync(join(src, ".git/config.worktree"), `[filter "evil"]\n\tclean = ${filter}\n`); },
  "submodule-defined filter": ({ src, dir, filter, sh }) => {
    const sub = join(dir, "sub");
    mkdirSync(sub); sh(sub, "init", "-q"); sh(sub, "config", "user.email", "t@t"); sh(sub, "config", "user.name", "t");
    writeFileSync(join(sub, "g"), "x\n"); writeFileSync(join(sub, ".gitattributes"), "* filter=evil\n"); sh(sub, "add", "."); sh(sub, "commit", "-qm", "s");
    sh(src, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"); sh(src, "commit", "-qm", "add sub");
    sh(src, "config", "-f", ".git/modules/sub/config", "filter.evil.clean", filter);
    writeFileSync(join(src, "sub/g"), "changed\n");
  },
};
for (const [name, route] of Object.entries(ROUTES)) test(`N1: owner git config reached through ${name} never runs, in the dry-run plan or in any install step`, () => {
  const dir = mkdtempSync(join(tmpdir(), "studio-n1-")), src = join(dir, "src"), ran = join(dir, "ran"), work = join(dir, "code.new");
  const sh = (cwd: string, ...a: string[]) => { const r = spawnSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null" } }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const filter = join(dir, "evil.sh"); writeFileSync(filter, `#!/bin/sh\necho ran >> '${ran}'\ncat\n`, { mode: 0o755 });
  mkdirSync(src); sh(src, "init", "-q"); sh(src, "config", "user.email", "t@t"); sh(src, "config", "user.name", "t");
  writeFileSync(join(src, "README.md"), "hi\n"); writeFileSync(join(src, ".gitattributes"), "* filter=evil\n");
  sh(src, "add", "."); sh(src, "commit", "-qm", "c");
  route({ src, dir, filter, sh });
  writeFileSync(join(src, "README.md"), "dirty working tree\n"); // a changed stat/content: what makes `git status` run clean filters
  // Control: the route really is a live attack against a plain `git status` as the owner would run it.
  sh(src, "status", "--porcelain"); assert.equal(existsSync(ran), true, "the repro is not live: even plain git status did not run the filter");
  rmSync(ran);
  const sha = sh(src, "rev-parse", "HEAD").trim(), sys: Sys = { ...fakeSys().sys, probe: (argv) => (argv[0] === "env" ? realSys.probe(argv) : fakeSys().sys.probe(argv)) };
  const oldHome = process.env.HOME; process.env.HOME = dir; // what `sudo` keeps on macOS
  try {
    // The dry-run's own question to the source (no --commit given), executed for real.
    const ask = planInstall({ ...base, base: "/opt/studio-n1", source: src }, { ...sys, probe: (argv) => { const r = sys.probe(argv); if (argv.includes("ls-remote")) assert.equal(r.stdout.split(/\s/)[0], sha); return r; } });
    assert.ok(ask.some((x) => x.title.includes(sha)));
    // The real install chain, in order, against the hostile source.
    const steps = planInstall({ ...base, base: "/opt/studio-n1", source: src, commit: sha }, sys).filter((s) => /new empty|fetch exactly|verify the fetched|check it out/.test(s.title));
    rmSync(work, { recursive: true, force: true });
    for (const step of steps) {
      const argv = step.argv!.map((x) => x.replace("/opt/studio-n1/code.new", work)), r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
      assert.equal(r.status, 0, step.title + "\n" + r.stderr);
      if (step.expect) assert.equal(r.stdout.trim(), step.expect);
    }
  } finally { process.env.HOME = oldHome; }
  assert.equal(existsSync(ran), false, "owner-controlled code ran as part of the install: " + (existsSync(ran) ? readFileSync(ran, "utf8") : ""));
  assert.equal(readFileSync(join(work, "README.md"), "utf8"), "hi\n", "the committed content (not the dirty tree) was installed");
});

/** M1 repros against a real temp repo: owner-controlled git config must not execute while the installer fetches. */
test("every git step ignores the owner's git config, repo hooks, fsmonitor and filter drivers", () => {
  const dir = mkdtempSync(join(tmpdir(), "studio-git-")), src = join(dir, "src"), home = join(dir, "home"), ran = join(dir, "ran");
  const sh = (cwd: string, ...a: string[]) => { const r = spawnSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" } }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  mkdirSync(src); mkdirSync(join(home, "tpl/hooks"), { recursive: true });
  sh(src, "init", "-q"); sh(src, "config", "user.email", "t@t"); sh(src, "config", "user.name", "t");
  writeFileSync(join(src, "README.md"), "hi\n"); writeFileSync(join(src, ".gitattributes"), "* filter=evil\n");
  sh(src, "add", "."); sh(src, "commit", "-qm", "c");
  const sha = sh(src, "rev-parse", "HEAD").trim();
  // Hostile setup: global templateDir hook that would persist in the clone, repo fsmonitor, a global packObjectsHook and smudge filter.
  const evil = (name: string) => { const f = join(dir, name + ".sh"); writeFileSync(f, `#!/bin/sh\necho ${name} >> '${ran}'\n`, { mode: 0o755 }); return f; };
  writeFileSync(join(home, "tpl/hooks/post-checkout"), `#!/bin/sh\necho template-hook >> '${ran}'\n`, { mode: 0o755 });
  const packHook = join(dir, "packhook.sh"), smudge = join(dir, "smudge.sh");
  writeFileSync(packHook, `#!/bin/sh\necho pack-objects-hook >> '${ran}'\nexec "$@"\n`, { mode: 0o755 });
  writeFileSync(smudge, `#!/bin/sh\necho global-smudge-filter >> '${ran}'\ncat\n`, { mode: 0o755 });
  // Global (HOME) config is the only place git honours uploadpack.packObjectsHook, and a global filter driver runs on checkout of the repo's .gitattributes.
  writeFileSync(join(home, ".gitconfig"), `[init]\n\ttemplateDir = ${join(home, "tpl")}\n[uploadpack]\n\tpackObjectsHook = ${packHook}\n[filter "evil"]\n\tsmudge = ${smudge}\n\tclean = cat\n`);
  sh(src, "config", "core.fsmonitor", evil("fsmonitor"));
  const work = join(dir, "code.new"), sys: Sys = { ...fakeSys().sys, probe: (argv) => (argv[0] === "env" ? realSys.probe(argv) : fakeSys().sys.probe(argv)) };
  const oldHome = process.env.HOME;
  process.env.HOME = home; // what `sudo` keeps on macOS
  try {
    const hostile = planInstall({ ...base, base: "/opt/studio-git-test", source: src, commit: sha }, sys);
    assert.equal(existsSync(ran), false, "planning executed owner-controlled code");
    for (const step of hostile.filter((s) => s.argv?.[0] === "env")) {
      const argv = step.argv!.map((x) => x.replace("/opt/studio-git-test/code.new", work));
      const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
      assert.equal(r.status, 0, step.title + "\n" + r.stderr);
      if (step.expect) assert.equal(r.stdout.trim(), sha);
    }
  } finally { process.env.HOME = oldHome; }
  assert.equal(existsSync(ran), false, "an install step executed owner-controlled code: " + (existsSync(ran) ? readFileSync(ran, "utf8") : ""));
  assert.equal(readFileSync(join(work, "README.md"), "utf8"), "hi\n", "the commit was really fetched and checked out");
  assert.equal(sh(work, "rev-parse", "HEAD").trim(), sha);
  assert.equal(existsSync(join(work, ".git/hooks/post-checkout")), false, "no template hook persists in the installed clone");
  assert.equal(existsSync(join(work, ".git/hooks/pre-commit.sample")), false, "git init --template= copies nothing");
  // A commit the source does not have is refused by the fetch itself.
  const wrong = planInstall({ ...base, base: "/opt/studio-git-test", source: src, commit: "b".repeat(40) }, sys).find((s) => s.argv?.includes("fetch"))!.argv!.map((x) => x.replace("/opt/studio-git-test/code.new", work));
  assert.notEqual(spawnSync(wrong[0], wrong.slice(1), { encoding: "utf8" }).status, 0);
});

/** The owner's view of a machine, derived from modes (not from per-test canned answers), so a permission change in a test changes every check. */
type Node = { uid: number; mode: number; content?: string; acl?: boolean; onlyCreate?: boolean; onlyWrite?: boolean };
function modelFs(tree: Record<string, Node>, over: { uid?: number; launchctl?: { status: number; stdout: string } } = {}): Fs {
  const me = over.uid ?? OWNER_UID;
  const can = (p: string, owner: number, other: number) => { const n = tree[p]; return !!n && ((n.uid === me ? n.mode & owner : n.mode & other) !== 0); };
  const canRead = (p: string) => can(p, 0o400, 0o004) || !!tree[p]?.acl;
  const canWrite = (p: string) => !tree[p]?.onlyCreate && can(p, 0o200, 0o002);
  return {
    uid: me,
    stat: (p) => (tree[p] ? { uid: tree[p].uid, mode: tree[p].mode } : null),
    canRead, canWrite,
    canCreateIn: (p) => !tree[p].onlyWrite && can(p, 0o200, 0o002) && (tree[p].mode & 0o170000) === 0o040000, // ACLs can grant one without the other
    read: (p) => (canRead(p) ? tree[p].content ?? "" : null),
    walk: (dir) => Object.entries(tree).filter(([p]) => p.startsWith(dir + "/")).map(([path, n]) => ({ path, uid: n.uid, mode: n.mode })),
    probe: () => over.launchctl ?? { status: 0, stdout: "\tusername = _studio\n" },
  };
}
const DIR = 0o40755, FILE = 0o100644;
/** A correctly installed machine as seen by the owner. */
function goodTree(o: Options = base): Record<string, Node> {
  const d = paths(o), t: Record<string, Node> = {};
  const root = (p: string, mode = DIR) => { t[p] = { uid: 0, mode }; };
  for (const p of ["/", "/Library", "/opt", "/usr", "/usr/local", "/usr/local/bin", o.plistDir, o.base, d.code]) root(p);
  root(o.node, 0o100755); root(d.code + "/studio-runner", DIR); root(d.code + "/studio-runner/a.ts", FILE); root(d.code + "/.git", DIR); root(d.code + "/.git/HEAD", FILE);
  t[d.code + "/link"] = { uid: 0, mode: 0o120777 }; // symlink modes are always 0777 and are not followed
  t[d.data] = { uid: SVC_UID, mode: 0o40700 }; t[d.home] = { uid: SVC_UID, mode: 0o40700 }; t[d.pub] = { uid: SVC_UID, mode: DIR };
  t[join(d.pub, "token")] = { uid: SVC_UID, mode: 0o100600, acl: true, content: "tok-123\n" };
  t[join(d.pub, "service.log")] = { uid: SVC_UID, mode: 0o100600, acl: true, content: "log\n" };
  t[d.plist] = { uid: 0, mode: FILE, content: plist(o) };
  return t;
}

test("verify passes on a correct install and, for every path it protects, fails when that path is wrong", () => {
  const good = verify(base, modelFs(goodTree()));
  assert.ok(good.every((r) => r.ok), good.map((r) => r.line).join("\n"));
  const d = paths(base), token = join(d.pub, "token");
  const cases: [string, (t: Record<string, Node>) => void, RegExp][] = [
    ["state root writable", (t) => { t[base.base].mode = 0o40777; }, /state root.*cannot write/],
    ["state root: create-only (ACL add_file)", (t) => { t[base.base].onlyCreate = true; t[base.base].mode = 0o40777; }, /state root.*cannot write/],
    ["state root: write-only", (t) => { t[base.base].onlyWrite = true; t[base.base].mode = 0o40777; }, /state root.*cannot write/],
    ["code writable", (t) => { t[d.code].mode = 0o40777; }, /code .*cannot write/],
    ["data writable", (t) => { t[d.data].mode = 0o40777; }, /data root.*cannot write/],
    ["home writable", (t) => { t[d.home].mode = 0o40777; }, /service home.*cannot write/],
    ["public writable", (t) => { t[d.pub].mode = 0o40777; }, /public dir.*cannot write/],
    ["data readable (0755 would leak the signing key and database)", (t) => { t[d.data].mode = DIR; }, /data root.*cannot read/],
    ["home readable (would leak the model login)", (t) => { t[d.home].mode = DIR; }, /service home.*cannot read/],
    ["data missing", (t) => { delete t[d.data]; }, /data root.*does not exist/],
    ["home missing", (t) => { delete t[d.home]; }, /service home.*does not exist/],
    ["code missing", (t) => { delete t[d.code]; }, /code .*does not exist/],
    ["state root missing", (t) => { delete t[base.base]; }, /state root.*does not exist/],
    ["public missing", (t) => { delete t[d.pub]; }, /public dir.*does not exist/],
    ["public owned by you", (t) => { t[d.pub].uid = OWNER_UID; }, /public dir.*owned by you/],
    ["data owned by you", (t) => { t[d.data].uid = OWNER_UID; }, /data root.*owned by you/],
    ["plist writable", (t) => { t[d.plist].mode = 0o100666; }, /launchd job.*not writable/],
    ["plist runs as the owner", (t) => { t[d.plist].content = plist({ ...base, user: "_studio" }).replace("<string>_studio</string>\n  <key>GroupName", "<string>alice</string>\n  <key>GroupName"); }, /launchd job.*runs as _studio/],
    ["plist missing", (t) => { delete t[d.plist]; }, /launchd job.*runs as _studio/],
    ["token unreadable", (t) => { t[token] = { uid: SVC_UID, mode: 0o100600, content: "tok" }; }, /token copy.*readable by you and not empty/],
    ["token empty", (t) => { t[token].content = ""; }, /token copy.*not empty/],
    ["token missing", (t) => { delete t[token]; }, /token copy.*not empty/],
    ["token writable", (t) => { t[token].mode = 0o100666; }, /token copy.*not writable/],
    ["log writable", (t) => { t[join(d.pub, "service.log")].mode = 0o100666; }, /log .*not writable/],
    ["code file owned by you", (t) => { t[d.code + "/studio-runner/a.ts"].uid = OWNER_UID; }, /code .*every file/],
    ["code file world-writable, deep", (t) => { t[d.code + "/.git/HEAD"].mode = 0o100666; }, /code .*every file.*HEAD/],
    ["code file group-writable", (t) => { t[d.code + "/studio-runner/a.ts"].mode = 0o100664; }, /code .*every file/],
    ["node binary writable", (t) => { t[base.node].mode = 0o100777; }, /node .*root-owned/],
    ["node ancestor writable", (t) => { t["/usr/local/bin"].mode = 0o40777; }, /node .*usr\/local\/bin/],
    ["node ancestor owned by you", (t) => { t["/usr/local"].uid = OWNER_UID; }, /node .*usr\/local\)/],
    ["/Library writable", (t) => { t["/Library"].mode = 0o40777; }, /ancestor \/Library:/],
    ["plist dir writable", (t) => { t[base.plistDir].mode = 0o40777; }, /ancestor \/Library\/LaunchDaemons:/],
    ["root dir writable", (t) => { t["/"].mode = 0o40777; }, /ancestor \/:/],
  ];
  for (const [name, mutate, expect] of cases) {
    const t = goodTree(); mutate(t);
    const bad = verify(base, modelFs(t)).filter((r) => !r.ok);
    assert.ok(bad.some((r) => expect.test(r.line)), name + "\n" + (bad.map((r) => r.line).join("\n") || "(verify passed)"));
  }
  // A plist dir that is not under a base ancestor has its own ancestors walked.
  const odd = { ...base, base: "/opt/ms", plistDir: "/Library/Other/LD" }, oddTree = goodTree(odd);
  oddTree["/Library/Other"] = { uid: 0, mode: DIR }; assert.ok(verify(odd, modelFs(oddTree)).every((r) => r.ok));
  oddTree["/Library/Other"].mode = 0o40777;
  assert.ok(verify(odd, modelFs(oddTree)).some((r) => !r.ok && /ancestor \/Library\/Other:/.test(r.line)));
  oddTree["/Library/Other"].mode = DIR; oddTree["/opt"].mode = 0o40777;
  assert.ok(verify(odd, modelFs(oddTree)).some((r) => !r.ok && /ancestor \/opt:/.test(r.line)), "the state root's own ancestors are walked");
  // launchd: not loaded, or loaded as someone else.
  assert.ok(verify(base, modelFs(goodTree(), { launchctl: { status: 113, stdout: "" } })).some((r) => !r.ok && /loaded/.test(r.line)));
  assert.ok(verify(base, modelFs(goodTree(), { launchctl: { status: 0, stdout: "\tusername = alice\n" } })).some((r) => !r.ok && /not running as anyone but _studio/.test(r.line)));
});

test("verify on an uninstalled machine fails instead of reporting 'not even visible'", () => {
  const empty = verify(base, modelFs({ "/": { uid: 0, mode: DIR }, "/Library": { uid: 0, mode: DIR } }));
  const failed = empty.filter((r) => !r.ok).map((r) => r.line).join("\n");
  for (const what of ["state root", "code", "data root", "service home", "public dir"]) assert.match(failed, new RegExp(what + ".*does not exist"));
  // Note 2: a check about a file that does not exist is a FAIL, never "ok ... not writable".
  for (const what of [/^code \S+: every file/, /launchd job .*: not writable/, /token copy .*: not writable/, /log .*: not writable/])
    assert.ok(empty.some((r) => what.test(r.line.slice(5)) && !r.ok), String(what) + "\n" + empty.map((r) => r.line).join("\n"));
});

test("verify as root is refused outright, with nothing else reported", () => {
  const r = verify(base, modelFs(goodTree(), { uid: 0 }));
  assert.equal(r.length, 1);
  assert.equal(r[0].ok, false);
  assert.equal(main(["verify", "--owner", "alice"], fakeSys().sys, modelFs(goodTree()), false, () => {}), 0);
  const t = goodTree(); t[paths(base).data].mode = DIR;
  assert.equal(main(["verify", "--owner", "alice"], fakeSys().sys, modelFs(t), false, () => {}), 1);
});

test("the real filesystem probes: protected dirs are unwritable, unreadable ones unreadable, the code tree is walked", () => {
  const fs = realFs(), mine = mkdtempSync(join(tmpdir(), "studio-verify-"));
  assert.equal(fs.canCreateIn(mine), true);
  assert.equal(fs.canWrite(mine), true);
  if (process.getuid!() !== 0) { assert.equal(fs.canCreateIn("/usr/bin"), false); assert.equal(fs.canWrite("/usr/bin"), false); }
  chmodSync(mine, 0o555);
  if (process.getuid!() !== 0) assert.equal(fs.canCreateIn(mine), false);
  chmodSync(mine, 0o755);
  // Owned by the caller means the caller can chmod it back: verify must fail even when the mode looks read-only.
  assert.equal(fs.stat(mine)!.uid, process.getuid!());
  // A real tree the test controls: data 0755 (readable) vs 0000, a missing home, a group-writable file deep in code/.
  const tree = mkdtempSync(join(tmpdir(), "studio-tree-")), o = { ...base, base: tree };
  for (const p of ["code/sub", "data", "public"]) mkdirSync(join(tree, p), { recursive: true });
  writeFileSync(join(tree, "code/sub/f"), "x"); chmodSync(join(tree, "code/sub/f"), 0o664); symlinkSync("/nonexistent", join(tree, "code/link"));
  const lines = () => verify(o, fs).map((r) => r.line).join("\n");
  assert.match(lines(), /FAIL service home .*does not exist/);
  assert.match(lines(), /FAIL data root .*cannot read or list it/, "0755 data is readable");
  assert.match(lines(), /FAIL code .*every file.*\(3 are not/, "the walk is recursive");
  assert.deepEqual(fs.walk(join(tree, "code")).map((e) => e.path.slice(tree.length + 1)).sort(), ["code/link", "code/sub", "code/sub/f"]);
  if (process.getuid!() !== 0) { chmodSync(join(tree, "data"), 0o000); assert.match(lines(), /ok   data root .*cannot read or list it/); chmodSync(join(tree, "data"), 0o700); }
});

const REPO = join(import.meta.dirname, "../..");
/** Runs studio-daemon. `script` is the body of a fake node's service run; `$TP` is the token path the REAL Service reports (--print-token-path is delegated to the real Service). */
function daemonSetup(script: string, tenant = "studio-self") {
  const dir = mkdtempSync(join(tmpdir(), "studio-daemon-")), pub = join(dir, "public"), data = join(dir, "data"), bin = join(dir, "bin"), log = join(dir, "chmod.log");
  for (const p of [pub, data, bin]) mkdirSync(p);
  const fakeNode = join(dir, "node");
  writeFileSync(fakeNode, `#!/bin/sh\ncase "$*" in *--print-token-path*) exec "$REAL_NODE" "$@";; esac\nTP=$("$REAL_NODE" "$@" --print-token-path)\nmkdir -p "$(dirname "$TP")"\n${script}`, { mode: 0o755 });
  writeFileSync(join(bin, "chmod"), `#!/bin/sh\necho "$@" >> '${log}'\ncase "$1" in -N|+a) exit 0;; esac\nexec /bin/chmod "$@"\n`, { mode: 0o755 }); // macOS ACLs need a real user: record them, delegate plain chmods
  const env = { PATH: bin + ":/usr/bin:/bin", REAL_NODE: process.execPath, STUDIO_NODE: fakeNode, STUDIO_CODE: REPO, STUDIO_DATA: data, STUDIO_PUBLIC: pub, STUDIO_OWNER: "alice", STUDIO_TENANT: tenant, STUDIO_PROVIDER: "claude-code-cli", STUDIO_PORT: "8765" };
  return { pub, data, log, env };
}
const WRAPPER = join(import.meta.dirname, "../bin/studio-daemon");
function runDaemon(script: string) { const d = daemonSetup(script); return { ...d, r: spawnSync("sh", [WRAPPER], { encoding: "utf8", timeout: 30000, env: d.env }) }; }

test("N2: the real Service and the real wrapper agree on the tenant directory, so the token copy is published", async () => {
  const { pub, data, env } = daemonSetup("exit 0\n");
  const child = spawn("sh", [WRAPPER], { env: { ...env, STUDIO_NODE: process.execPath, STUDIO_PROVIDER: "fixture", STUDIO_PORT: "0" }, stdio: "ignore" });
  const closed = new Promise((res) => child.once("close", res));
  try {
    for (let i = 0; i < 100 && !existsSync(join(pub, "token")); i++) await new Promise((res) => setTimeout(res, 200));
    const [tenantDir] = readdirSync(join(data, "tenants"));
    assert.equal(tenantDir.length, 32, "the Service's own tenant directory name");
    assert.equal(existsSync(join(pub, "token")), true, "the wrapper looked in the directory the Service really created");
    assert.equal(readFileSync(join(pub, "token"), "utf8"), readFileSync(join(data, "tenants", tenantDir, "token"), "utf8"));
    assert.ok(readFileSync(join(pub, "token"), "utf8").trim().length > 20);
  } finally { child.kill("SIGTERM"); await Promise.race([closed, new Promise((res) => setTimeout(res, 5000))]); child.kill("SIGKILL"); }
});

test("the daemon wrapper starts the Service with the tenant config and publishes an owner-readable token copy", () => {
  const { r, pub, log } = runDaemon(`echo tok-123 > "$TP"\necho "args: $@"\necho "umask: $(umask)"\necho "No owner passkey yet. code: SETUP-1"\nsleep 2\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(pub, "token"), "utf8"), "tok-123\n");
  assert.equal(statSync(join(pub, "token")).mode & 0o777, 0o600);
  const service = readFileSync(join(pub, "service.log"), "utf8");
  assert.match(service, /--data-root .*\/data --tenant studio-self --provider claude-code-cli --port 8765 --workspace .*\/templates\/workspace\/studio-self/);
  assert.match(service, /SETUP-1/, "the one-time setup code reaches the owner-readable log");
  assert.match(service, /umask: 0?077/, "the Service and the log it writes start under umask 077");
  const acl = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("+a"));
  assert.equal(acl.length, 2);
  assert.ok(acl.every((l) => l.startsWith("+a user:alice allow read ")), acl.join("\n"));
});

test("L1: the published token is this tenant's, not the alphabetically first one", () => {
  const { r, pub } = runDaemon(`mkdir -p "$(dirname "$TP")/../0000old"\necho OLD-TENANT > "$(dirname "$TP")/../0000old/token"\necho tok-NEW > "$TP"\nsleep 2\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(pub, "token"), "utf8"), "tok-NEW\n");
});

test("L1: an empty token (the Service has created the file but not written it yet) is never published", () => {
  const { r, pub } = runDaemon(`: > "$TP"\nsleep 2\necho tok-LATE > "$TP"\nsleep 3\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(pub, "token"), "utf8"), "tok-LATE\n");
});
