/**
 * the tracked authority milestone: install the Studio Service as a launchd daemon under a dedicated macOS user, so the owner's login user
 * cannot write the authority store, keys, database or the code that runs as the daemon.
 * This module only PLANS and VERIFIES. It changes the machine only when `run` is given a Sys that executes and the caller is root.
 */
import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, lstatSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./runner.ts";

export type Options = { owner: string; user: string; source: string; node: string; base: string; tenant: string; provider: string; port: number; label: string; plistDir: string; purge: boolean; commit: string };
/** `expect`: run argv as a read-only probe and require its trimmed stdout to equal this (otherwise the step fails). */
export type Step = { title: string; argv?: string[]; write?: { path: string; content: string; mode: number }; allowFail?: boolean; expect?: string };
export type Sys = {
  /** Read-only commands only (dscl -read, git ls-remote ...); also run during --dry-run. */
  probe(argv: string[]): { status: number; stdout: string };
  /** State-changing commands; only called after the caller has confirmed root. */
  exec(argv: string[]): number;
  read(path: string): string | null;
  write(path: string, content: string, mode: number): void;
  stat(path: string): { uid: number; mode: number } | null;
  realpath(path: string): string;
};

export const defaults = (env: NodeJS.ProcessEnv = process.env): Options => ({
  owner: env.SUDO_USER || userInfo().username, user: "_studio", source: REPO_ROOT.replace(/\/$/, ""), node: realpathSync(process.execPath),
  base: "/Library/MarketingStudio", tenant: "studio-self", provider: "fixture", port: 8765,
  label: "com.marketing-studio.service", plistDir: "/Library/LaunchDaemons", purge: false, commit: "",
});
export const paths = (o: Options) => ({ code: join(o.base, "code"), data: join(o.base, "data"), home: join(o.base, "home"), pub: join(o.base, "public"), plist: join(o.plistDir, o.label + ".plist") });

const PROVIDERS = ["fixture", "claude-code-cli", "codex-cli"];
export function validate(o: Options) {
  const bad = (what: string) => { throw new Error("Invalid " + what); };
  if (!/^_[a-z][a-z0-9_-]{1,30}$/.test(o.user)) bad("--user (use an underscore-prefixed name such as _studio)");
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(o.owner) || o.owner === o.user || o.owner === "root") bad("--owner (the login user, not root or the service user)");
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(o.tenant)) bad("--tenant");
  if (!PROVIDERS.includes(o.provider)) bad("--provider");
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535) bad("--port");
  for (const [k, v] of Object.entries({ node: o.node, source: o.source }))
    if (!/^\/[A-Za-z0-9._\/-]+$/.test(v) || v.includes("..")) bad("--" + k + " (absolute path, no spaces or '..')");
  // The uninstall deletes recursively under --base, so it may only point at a directory this tool could own.
  if (!/^\/(Library|opt)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(o.base) || o.base.includes("..")) bad("--base (a directory under /Library/ or /opt/, no spaces or '..')");
  if (!/^\/Library\/[A-Za-z0-9._\/-]+$/.test(o.plistDir) || o.plistDir.includes("..")) bad("--plist-dir (a directory under /Library/)");
  if (!/^[A-Za-z0-9.-]{1,100}$/.test(o.label)) bad("--label (letters, digits, '.' and '-')");
  if (o.commit && !/^[0-9a-f]{40}$/.test(o.commit)) bad("--commit (the full 40-character sha)");
}

/** An allow-ACE that grants write-like rights to anyone (e.g. group:admin, which contains the owner) is as bad as a group/world-writable mode. */
const WRITE_ACE = /^\s*\d+: .* allow .*\b(write|append|add_file|add_subdirectory|delete|delete_child|writeattr|writeextattr|writesecurity|chown)\b/m;
/** The daemon executes node as the service user; any non-root-owned or group/world/ACL-writable file or ancestor lets the owner run code as that user. */
export function untrusted(path: string, sys: Sys): string | null {
  for (let p = sys.realpath(path); ; p = dirname(p)) {
    const s = sys.stat(p);
    if (!s || s.uid !== 0 || (s.mode & 0o022) !== 0 || WRITE_ACE.test(sys.probe(["ls", "-lde", p]).stdout)) return p;
    if (p === "/") return null;
  }
}

/**
 * Every git step runs with no user or system config, no hooks, no fsmonitor and no submodule recursion. The installer runs as root and the
 * owner's repo is owner-controlled, so NO git command may read the owner's checkout or its config: the source is only ever a remote to fetch from.
 */
export function gitArgv(...a: string[]): string[] {
  const sudo = /^\d+$/.test(process.env.SUDO_UID ?? "") ? ["SUDO_UID=" + process.env.SUDO_UID] : []; // lets git's own ownership check accept the owner's repo under sudo
  return ["env", "-i", "HOME=/var/empty", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", ...sudo, "/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", ...a];
}

/** Written by install, required by uninstall before any recursive delete. */
const MARKER = ".marketing-studio-install";
const marker = (o: Options) => `marketing-studio-core separate-user install\nuser=${o.user}\n`;
const REAL_NAME = "Marketing Studio Service";
/** `dscl -read` prints `Key: value` or `Key:\n value`. */
const dsclValue = (stdout: string) => stdout.replace(/^\S+:\s*/, "").trim();
const attrs = (o: Options) => [["RealName", REAL_NAME], ["UserShell", "/usr/bin/false"], ["NFSHomeDirectory", paths(o).home], ["Password", "*"], ["IsHidden", "1"]] as const;

const free = (probe: Sys["probe"], path: string, key: string) => new Set(probe(["dscl", ".", "-list", path, key]).stdout.split("\n").map((l) => Number(l.trim().split(/\s+/)[1])));
function freeId(sys: Sys) {
  const taken = new Set([...free(sys.probe, "/Users", "UniqueID"), ...free(sys.probe, "/Groups", "PrimaryGroupID")]);
  for (let id = 300; id < 400; id++) if (!taken.has(id)) return id;
  throw new Error("No free id in 300-399 for the service user");
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(o: Options) {
  const d = paths(o);
  const env: Record<string, string> = {
    STUDIO_NODE: o.node, STUDIO_CODE: d.code, STUDIO_DATA: d.data, STUDIO_PUBLIC: d.pub, STUDIO_OWNER: o.owner, STUDIO_TENANT: o.tenant,
    STUDIO_PROVIDER: o.provider, STUDIO_PORT: String(o.port), HOME: d.home, PATH: d.home + "/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    // The code clone is root-owned and the daemon is not root: tell git to trust it so skill-pin checks still see a clean HEAD.
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: d.code,
  };
  const dict = Object.entries(env).map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${esc(o.label)}</string>
  <key>UserName</key><string>${esc(o.user)}</string>
  <key>GroupName</key><string>${esc(o.user)}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${esc(d.code)}/studio-runner/bin/studio-daemon</string></array>
  <key>WorkingDirectory</key><string>${esc(d.home)}</string>
  <key>EnvironmentVariables</key><dict>
${dict}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
</dict></plist>
`;
}

/** Stop the daemon first. If it is loaded and refuses to stop, the plan fails here instead of swapping code under a running process. */
const stopStep = (o: Options, sys: Sys): Step[] =>
  sys.probe(["launchctl", "print", "system/" + o.label]).status === 0 ? [{ title: "stop the running daemon before touching its code", argv: ["launchctl", "bootout", "system/" + o.label] }] : [];

export function planInstall(o: Options, sys: Sys): Step[] {
  validate(o);
  const d = paths(o), u = o.user;
  const badNode = untrusted(o.node, sys);
  if (badNode) throw new Error(`Refusing: ${badNode} is not root-owned or is writable by a non-root user (mode bits or ACL), and the daemon would run ${o.node} as ${u}. Install the official Node.js (nodejs.org) package or copy its node binary to a root-owned path and pass --node. Homebrew and nvm node are owner-writable.`);
  // `-C /`: never discover a repository from the installer's working directory (under sudo that is usually the owner's checkout).
  const fromSource = ["-C", "/", "-c", "protocol.file.allow=always"];
  let sha = o.commit;
  if (!sha) { // dry-run only (main refuses a real run without --commit): ask the source what HEAD is, through the same fetch path as the install.
    const r = sys.probe(gitArgv(...fromSource, "ls-remote", o.source, "HEAD"));
    sha = r.stdout.split(/\s/)[0];
    if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("--source is not a git repository with a HEAD; the daemon runs a pinned, root-owned clone of a commit");
  }
  const steps: Step[] = [...stopStep(o, sys)];
  const dscl = (path: string, ...kv: string[]) => steps.push({ title: `directory record ${path}`, argv: ["dscl", ".", "-create", path, ...kv] });
  const groupId = sys.probe(["dscl", ".", "-read", "/Groups/" + u, "PrimaryGroupID"]);
  const read = (key: string) => dsclValue(sys.probe(["dscl", ".", "-read", "/Users/" + u, key]).stdout);
  if (sys.probe(["dscl", ".", "-read", "/Users/" + u, "UniqueID"]).status === 0) {
    // Never trust an existing account: it must be ours, outside the admin group, and have every attribute we set (a half-finished earlier run is repaired).
    if (read("RealName") !== REAL_NAME) throw new Error(`Refusing: /Users/${u} exists but is not the Marketing Studio Service user (RealName is not "${REAL_NAME}"); pick another --user`);
    if (sys.probe(["dscl", ".", "-read", "/Groups/admin", "GroupMembership"]).stdout.split(/\s+/).includes(u)) throw new Error(`Refusing: ${u} is in the admin group`);
    for (const [k, v] of attrs(o)) if (read(k) !== v) dscl("/Users/" + u, k, v);
  } else {
    const id = groupId.status === 0 ? Number(groupId.stdout.trim().split(/\s+/).pop()) : freeId(sys);
    if (groupId.status !== 0) { dscl("/Groups/" + u); dscl("/Groups/" + u, "PrimaryGroupID", String(id)); }
    dscl("/Users/" + u);
    for (const [k, v] of [["UniqueID", String(id)], ["PrimaryGroupID", String(id)], ...attrs(o)]) dscl("/Users/" + u, k, v);
  }
  steps.push({ title: "state root, root-owned so the owner cannot swap the directories below it", argv: ["install", "-d", "-m", "0755", "-o", "root", "-g", "wheel", o.base] });
  steps.push({ title: "install marker: uninstall refuses to delete anything under a base without it", write: { path: join(o.base, MARKER), content: marker(o), mode: 0o644 } });
  steps.push({ title: "data root and service home: service user only (authority store, keys, database, jobs, model login)", argv: ["install", "-d", "-m", "0700", "-o", u, "-g", u, d.data, d.home] });
  steps.push({ title: "public dir: holds only the owner-readable token copy and log", argv: ["install", "-d", "-m", "0755", "-o", u, "-g", u, d.pub] });
  steps.push({ title: "fresh root-owned clone of the source commit " + sha, argv: ["rm", "-rf", d.code + ".new"] });
  // init+fetch by sha (not clone) so a detached-HEAD worktree works; the commit's .git is what the skill-pin checks read.
  const clone = d.code + ".new";
  steps.push({ title: "new empty repository (no templates, so no hooks)", argv: gitArgv("-C", "/", "init", "--quiet", "--template=", clone) });
  // The owner's checkout is never opened (no status, rev-parse or config): its objects are fetched by sha as a remote, its dirty state is irrelevant.
  steps.push({ title: "fetch exactly that commit from the source as a remote", argv: gitArgv("-C", clone, "-c", "protocol.file.allow=always", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", o.source, sha) });
  steps.push({ title: "verify the fetched commit is exactly --commit", argv: gitArgv("-C", clone, "rev-parse", "--verify", "FETCH_HEAD^{commit}"), expect: sha });
  steps.push({ title: "check it out", argv: gitArgv("-C", clone, "checkout", "--quiet", "--detach", sha) });
  steps.push({ title: "no group/world write anywhere in the code", argv: ["chmod", "-R", "go-w", d.code + ".new"] });
  steps.push({ title: "swap the clone in", argv: ["rm", "-rf", d.code] });
  steps.push({ title: "swap the clone in", argv: ["mv", d.code + ".new", d.code] });
  steps.push({ title: "launchd job", write: { path: d.plist, content: plist(o), mode: 0o644 } });
  steps.push({ title: "launchd requires root:wheel on the plist", argv: ["chown", "root:wheel", d.plist] });
  steps.push({ title: "start the daemon", argv: ["launchctl", "bootstrap", "system", d.plist] });
  return steps;
}

export function planUninstall(o: Options, sys: Sys): Step[] {
  validate(o);
  const d = paths(o), found = sys.read(join(o.base, MARKER));
  if (found !== marker(o)) throw new Error(`Refusing: ${join(o.base, MARKER)} is missing or is not for user ${o.user}, so ${o.base} is not a Marketing Studio install this tool may delete`);
  const steps: Step[] = [
    ...stopStep(o, sys),
    { title: "remove the launchd job", argv: ["rm", "-f", d.plist] },
    { title: "remove the code clone", argv: ["rm", "-rf", d.code, d.code + ".new"] },
  ];
  if (o.purge) {
    const user = sys.probe(["dscl", ".", "-read", "/Users/" + o.user, "UniqueID"]).status === 0;
    const read = (key: string) => dsclValue(sys.probe(["dscl", ".", "-read", "/Users/" + o.user, key]).stdout);
    if (user && (read("RealName") !== REAL_NAME || read("NFSHomeDirectory") !== d.home)) throw new Error(`Refusing to delete /Users/${o.user}: it is not the Marketing Studio Service user for ${o.base}`);
    steps.push({ title: "PURGE: delete the authority store, keys, tenant data, model login, token copy and log", argv: ["rm", "-rf", d.data, d.home, d.pub] });
    steps.push({ title: "remove the install marker", argv: ["rm", "-f", join(o.base, MARKER)] });
    steps.push({ title: "remove the state root if empty", argv: ["rmdir", o.base], allowFail: true });
    if (user) steps.push({ title: "delete the service user", argv: ["dscl", ".", "-delete", "/Users/" + o.user] });
    if (sys.probe(["dscl", ".", "-read", "/Groups/" + o.user, "PrimaryGroupID"]).status === 0) steps.push({ title: "delete the service group", argv: ["dscl", ".", "-delete", "/Groups/" + o.user] });
  }
  return steps;
}

const q = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'");
/** Prints every step before it runs; with dryRun nothing is executed. */
export function run(steps: Step[], sys: Sys, out: (line: string) => void, dryRun: boolean) {
  for (const s of steps) {
    out("# " + s.title);
    if (s.write) out(`$ write ${s.write.path} (mode ${s.write.mode.toString(8)})\n${s.write.content.replace(/^/gm, "    ")}`);
    else out("$ " + s.argv!.map(q).join(" "));
    if (dryRun) continue;
    if (s.write) sys.write(s.write.path, s.write.content, s.write.mode);
    else if (s.expect !== undefined) { const r = sys.probe(s.argv!); if (r.status !== 0 || r.stdout.trim() !== s.expect) throw new Error("Verification failed: " + s.title); }
    else if (sys.exec(s.argv!) !== 0 && !s.allowFail) throw new Error("Step failed: " + s.argv!.join(" "));
  }
}

export const realSys: Sys = {
  probe: (argv) => { const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" }); return { status: r.status ?? 1, stdout: r.stdout ?? "" }; },
  exec: (argv) => spawnSync(argv[0], argv.slice(1), { stdio: "inherit" }).status ?? 1,
  read: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
  write: (p, c, m) => { writeFileSync(p, c, { mode: m }); chmodSync(p, m); },
  stat: (p) => { try { const s = lstatSync(p); return { uid: s.uid, mode: s.mode }; } catch { return null; } },
  realpath: (p) => realpathSync(p),
};

export type Entry = { path: string; uid: number; mode: number };
export type Fs = {
  uid: number;
  stat(path: string): { uid: number; mode: number } | null;
  canWrite(path: string): boolean;
  canRead(path: string): boolean;
  /** Really tries to create a file in dir, then removes it. */
  canCreateIn(dir: string): boolean;
  read(path: string): string | null;
  /** Every entry below dir (lstat, symlinks not followed). */
  walk(dir: string): Entry[];
  probe(argv: string[]): { status: number; stdout: string };
};
const walkReal = (dir: string): Entry[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const path = join(dir, e.name), s = lstatSync(path);
  return [{ path, uid: s.uid, mode: s.mode }, ...(e.isDirectory() ? walkReal(path) : [])];
});
export const realFs = (): Fs => ({
  uid: process.getuid!(),
  stat: (p) => { try { const s = lstatSync(p); return { uid: s.uid, mode: s.mode }; } catch { return null; } },
  canWrite: (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } },
  canRead: (p) => { try { accessSync(p, constants.R_OK); return true; } catch { return false; } },
  canCreateIn: (dir) => {
    const probe = join(dir, ".owner-write-probe-" + process.pid);
    try { closeSync(openSync(probe, "wx")); unlinkSync(probe); return true; } catch { return false; }
  },
  read: realSys.read,
  walk: (dir) => { try { return walkReal(dir); } catch { return []; } },
  probe: realSys.probe,
});

/** Run as the OWNER (not root). Each line is one check; ok=false means the owner could tamper with, or read, what they must not. */
export function verify(o: Options, fs: Fs): { ok: boolean; line: string }[] {
  const d = paths(o), res: { ok: boolean; line: string }[] = [];
  const add = (ok: boolean, line: string) => res.push({ ok, line: (ok ? "ok   " : "FAIL ") + line });
  if (fs.uid === 0) return [{ ok: false, line: "FAIL run verify as the owner login user, not root: root can write everywhere, so the result would mean nothing" }];
  // [what, dir, secret]: secret dirs (mode 0700) must also be unreadable, not just unwritable.
  for (const [what, dir, secret] of [["state root", o.base, false], ["code", d.code, false], ["data root (authority store, keys, database)", d.data, true], ["service home (model login)", d.home, true], ["public dir", d.pub, false]] as const) {
    const s = fs.stat(dir);
    if (!s) { add(false, `${what} ${dir} does not exist: the service is not installed`); continue; }
    if (s.uid === fs.uid) add(false, `${what} ${dir} is owned by you, so you can change it`);
    else add(!fs.canWrite(dir) && !fs.canCreateIn(dir), `${what} ${dir}: cannot write or create files`);
    if (secret) add(!fs.canRead(dir), `${what} ${dir}: cannot read or list it`);
  }
  const loose = fs.walk(d.code).filter((e) => e.uid !== 0 || ((e.mode & 0o170000) !== 0o120000 && (e.mode & 0o022) !== 0));
  const there = (p: string) => !!fs.stat(p); // a check about a file that does not exist must FAIL, not "ok: not writable"
  add(there(d.code) && loose.length === 0, `code ${d.code}: every file is root-owned and not group/world-writable` + (loose.length ? ` (${loose.length} are not, e.g. ${loose[0].path})` : ""));
  const text = fs.read(d.plist);
  add(there(d.plist) && !fs.canWrite(d.plist), `launchd job ${d.plist}: not writable`);
  add(text !== null && text.includes(`<key>UserName</key><string>${o.user}</string>`), `launchd job ${d.plist}: runs as ${o.user}`);
  const node = text?.match(/<key>STUDIO_NODE<\/key><string>([^<]+)<\/string>/)?.[1];
  const badNode = node === undefined ? "(no STUDIO_NODE in the plist)" : nodeChain(node).find((p) => fs.stat(p)?.uid !== 0 || fs.canWrite(p));
  add(badNode === undefined, `node ${node ?? "?"}: it and every ancestor are root-owned and not writable by you` + (badNode ? ` (${badNode})` : ""));
  const loaded = fs.probe(["launchctl", "print", "system/" + o.label]), runsAs = loaded.stdout.match(/^\s*username = (\S+)/m)?.[1];
  add(loaded.status === 0 && (runsAs === undefined || runsAs === o.user), `launchd system/${o.label}: loaded` + (loaded.status === 0 ? ` and not running as anyone but ${o.user}` : " (launchctl print failed; is the daemon installed and loaded?)"));
  const ancestors = new Set<string>();
  for (let p = dirname(o.base); ; p = dirname(p)) { ancestors.add(p); if (p === "/") break; }
  for (let p = o.plistDir; ; p = dirname(p)) { ancestors.add(p); if (p === "/") break; }
  for (const p of ancestors) add(!fs.canWrite(p), `ancestor ${p}: not writable (otherwise it could be renamed and replaced)`);
  const token = join(d.pub, "token"), log = join(d.pub, "service.log");
  add(!!fs.read(token)?.trim(), `token copy ${token}: readable by you and not empty (for STUDIO_TOKEN)`);
  add(there(token) && !fs.canWrite(token), `token copy ${token}: not writable by you`);
  add(there(log) && !fs.canWrite(log), `log ${log}: not writable by you`);
  return res;
}
const nodeChain = (node: string) => { const out: string[] = []; for (let p = node; ; p = dirname(p)) { out.push(p); if (p === "/") return out; } };

/** A mistake guard, not a defence: it runs inside the installer after its modules are loaded, so code already running as the owner can bypass it. The protection is running a root-owned copy (docs/operations/SEPARATE-USER-INSTALL.md). */
export function selfCheck(sys: Sys, files = [fileURLToPath(import.meta.url), fileURLToPath(new URL("../bin/studio-install", import.meta.url)), realpathSync(process.execPath)]) {
  for (const f of files) {
    const bad = untrusted(f, sys);
    if (bad) throw new Error(`Refusing (--self-check): ${bad} is not root-owned or is writable by a non-root user, and this installer would run ${f} as root. Run it from a root-owned copy of the reviewed commit with a root-owned node (docs/operations/SEPARATE-USER-INSTALL.md).`);
  }
}

function parse(argv: string[]) {
  const o = defaults(), cmd = argv[0], flags = new Set<string>();
  const key: Record<string, keyof Options> = { "--owner": "owner", "--user": "user", "--source": "source", "--node": "node", "--base": "base", "--tenant": "tenant", "--provider": "provider", "--port": "port", "--label": "label", "--plist-dir": "plistDir", "--commit": "commit" };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (key[a]) { const v = argv[++i]; if (v === undefined) throw new Error("Missing value for " + a); (o as Record<string, unknown>)[key[a]] = key[a] === "port" ? Number(v) : v; }
    else if (a === "--dry-run" || a === "--purge" || a === "--self-check") flags.add(a);
    else throw new Error("Unknown option " + a);
  }
  o.purge = flags.has("--purge");
  return { cmd, o, dryRun: flags.has("--dry-run"), check: flags.has("--self-check") };
}

export function main(argv: string[], sys: Sys = realSys, fs: Fs = realFs(), isRoot = process.getuid?.() === 0, out: (line: string) => void = (l) => void process.stdout.write(l + "\n")) {
  const { cmd, o, dryRun, check } = parse(argv);
  if (cmd === "verify") { validate(o); const r = verify(o, fs); r.forEach((x) => out(x.line)); return r.every((x) => x.ok) ? 0 : 1; }
  if (cmd !== "install" && cmd !== "uninstall") throw new Error("Usage: studio-install install|uninstall|verify [--dry-run] [--owner NAME] [--provider fixture|claude-code-cli|codex-cli] [--node PATH] [--port N] [--tenant ID] [--purge] [--commit SHA] [--self-check]");
  if (check) selfCheck(sys);
  if (cmd === "install" && !o.commit && (!dryRun || isRoot)) throw new Error("A real install needs --commit <40-char sha>: the sha that `install --dry-run`, run as yourself (not root), printed and you reviewed");
  const steps = cmd === "install" ? planInstall(o, sys) : planUninstall(o, sys);
  if (!dryRun && !isRoot) { out("Not root: nothing was run. Review the plan with --dry-run, then run the same command with sudo."); return 2; }
  const pinned = steps.map((x) => x.title.match(/source commit ([0-9a-f]{40})/)?.[1]).find(Boolean);
  if (dryRun && pinned) out(`# Reviewed commit: ${pinned}. The real run must say --commit ${pinned}; it refuses if HEAD has moved.`);
  run(steps, sys, out, dryRun);
  out(dryRun ? "Dry run: nothing was changed." : cmd === "install" ? "Installed. Next: see docs/operations/SEPARATE-USER-INSTALL.md (owner passkey, token, model login, verify)." : "Uninstalled" + (o.purge ? " and purged." : "; data, service user and model login were kept (use --purge to delete them)."));
  return 0;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : "unknown error") + "\n"); process.exitCode = 2; }
}
