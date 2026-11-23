import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { StudioService } from "../src/service/studio-service.ts";
import { REPO_ROOT } from "../src/runner.ts";
import { TestOwnerVerifier } from "./helpers/test-owner-verifier.ts";
import { sourceWorkspace } from "./helpers/service-fixture.ts";

const BRIDGE_DIR = join(REPO_ROOT, "studio-runner/bridge");
const BRIDGE = join(BRIDGE_DIR, "index.js");
const owner = new TestOwnerVerifier();
const service = () => new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-bridge-")), tenantId: "bridge", workspace: sourceWorkspace(), ownerVerifier: owner });
const rpc = (id: number | undefined, method: string, params?: object) => JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });

/** Runs the real bridge process: sends lines, waits for `replies` stdout lines, then closes stdin and waits for exit. */
function run(env: Record<string, string>, lines: string[], replies = lines.length, opts: { script?: string; execArgv?: string[] } = {}) {
  return new Promise<{ out: string[]; stdout: string; stderr: string; code: number | null }>((ok, fail) => {
    const p = spawn(process.execPath, [...(opts.execArgv ?? []), opts.script ?? BRIDGE], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "", stderr = "";
    p.stdout.setEncoding("utf8").on("data", (c) => {
      stdout += c;
      if (stdout.split("\n").filter(Boolean).length >= replies) p.stdin.end();
    });
    p.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    p.stdin.on("error", () => {}); // the child may exit before we finish writing (a crash case)
    p.on("error", fail);
    p.on("close", (code) => ok({ out: stdout.split("\n").filter(Boolean), stdout, stderr, code }));
    for (const l of lines) p.stdin.write(l + "\n");
    if (replies === 0) p.stdin.end();
    setTimeout(() => p.kill(), 20_000).unref();
  });
}

/** Copies the bridge folder the way `mcpb pack` ships it, into a temp dir outside the repo. */
function packedLayout(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-bridge-packed-"));
  for (const f of readdirSync(BRIDGE_DIR)) copyFileSync(join(BRIDGE_DIR, f), join(dir, f));
  return dir;
}

/** The packed layout must not inherit a package.json from above, or the test would prove nothing. */
function assertNoParentPackageJson(dir: string) {
  for (let d = dirname(dir); ; d = dirname(d)) {
    assert.equal(existsSync(join(d, "package.json")), false, `stray package.json above the temp dir: ${d}`);
    if (dirname(d) === d) break;
  }
}

test("tools/list and tools/call round-trip, tool list unchanged, notifications silent", async () => {
  const s = service();
  const port = await s.listen();
  try {
    const env = { STUDIO_TOKEN: s.token, STUDIO_PORT: String(port) };
    const r = await run(env, [
      rpc(1, "initialize", { protocolVersion: "2025-06-18" }),
      rpc(undefined, "notifications/initialized"), // 202: no reply line
      rpc(2, "tools/list"),
      rpc(3, "tools/call", { name: "session_status", arguments: {} }),
    ], 3);
    assert.equal(r.code, 0);
    const by = Object.fromEntries(r.out.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    assert.equal(by[1].result.protocolVersion, "2025-06-18");
    assert.deepEqual(by[2].result.tools, s.listTools(), "bridge must not add, drop or edit tools");
    assert.ok(by[2].result.tools.length > 0);
    assert.deepEqual(JSON.parse(by[3].result.content[0].text), [], "no sessions yet, from the Service");
    assert.equal(r.stderr, "");
  } finally { await s.close(); }
});

test("a wrong token gives a JSON-RPC error with the request id, and the token never leaks", async () => {
  const s = service();
  const port = await s.listen();
  const wrong = "wrong-token-do-not-print-0123456789";
  try {
    const r = await run({ STUDIO_TOKEN: wrong, STUDIO_PORT: String(port) }, [rpc(7, "tools/list")]);
    const m = JSON.parse(r.out[0]);
    assert.equal(m.id, 7);
    assert.equal(m.error.message, "Studio Service rejected the token (401). Check the token in the extension settings.");
    for (const text of [r.stdout, r.stderr]) { assert.ok(!text.includes(wrong)); assert.ok(!text.includes(s.token)); }
  } finally { await s.close(); }
});

test("the real token never appears on stdout or stderr, even for a malformed line and a down Service", async () => {
  const s = service();
  const port = await s.listen();
  const token = s.token;
  const ok = await run({ STUDIO_TOKEN: token, STUDIO_PORT: String(port) }, ["{not json", rpc(1, "ping")]);
  assert.equal(ok.out.length, 2);
  assert.equal(JSON.parse(ok.out[0]).id, null);
  assert.equal(JSON.parse(ok.out[1]).id, 1);
  await s.close();
  const down = await run({ STUDIO_TOKEN: token, STUDIO_PORT: String(port) }, [rpc(2, "ping")]);
  assert.match(JSON.parse(down.out[0]).error.message, /Cannot reach/);
  for (const r of [ok, down]) { assert.ok(!r.stdout.includes(token)); assert.ok(!r.stderr.includes(token)); }
});

test("non-loopback targets are refused before any request is sent", async () => {
  let hits = 0;
  const decoy = createServer((_q, res) => { hits++; res.end("{}"); });
  await new Promise<void>((r) => decoy.listen(0, "127.0.0.1", r));
  const dport = (decoy.address() as { port: number }).port;
  const token = "tok-refusal-test";
  try {
    for (const url of [
      "http://example.com:8765/mcp",
      `http://localhost:${dport}/mcp`,
      `http://127.0.0.1@localhost:${dport}/mcp`,
      `http://127.0.0.1.evil.example:${dport}/mcp`,
      `https://127.0.0.1:${dport}/mcp`,
      `http://[::1]:${dport}/mcp`,
      `http://192.168.1.5:${dport}/mcp`,
      `http://127.0.0.1:${dport}/other`,
      `http://127.0.0.1@127.0.0.1:${dport}/mcp`,
      `http://user:pass@127.0.0.1:${dport}/mcp`,
      `http://127.0.0.1:${dport}/mcp?x=1`,
      `http://127.0.0.1:${dport}/mcp#frag`,
      `http://127.0.0.1:0/mcp`,
    ]) {
      const r = await run({ STUDIO_TOKEN: token, STUDIO_BRIDGE_URL: url }, [], 0);
      assert.equal(r.code, 2, url);
      assert.match(r.stderr, /Refusing/, url);
      assert.equal(r.stdout, "");
      assert.ok(!r.stderr.includes(token));
    }
    const badPort = await run({ STUDIO_TOKEN: token, STUDIO_PORT: "99999" }, [], 0);
    assert.equal(badPort.code, 2);
    const noToken = await run({ STUDIO_PORT: String(dport) }, [], 0);
    assert.equal(noToken.code, 2);
    assert.equal(hits, 0, "nothing may reach the decoy listener");
  } finally { decoy.close(); }
});

test("the packed bridge folder runs as ESM with no parent package.json (Node 20.3-20.18 parses index.js as CommonJS)", async () => {
  const dir = packedLayout();
  assertNoParentPackageJson(dir);
  const s = service();
  const port = await s.listen();
  try {
    // Node 26 detects ESM syntax by itself; this flag reproduces the older-Node behaviour the manifest's >=20.3 floor allows.
    const r = await run({ STUDIO_TOKEN: s.token, STUDIO_PORT: String(port) }, [rpc(1, "tools/list")], 1, { script: join(dir, "index.js"), execArgv: ["--no-experimental-detect-module"] });
    assert.equal(r.stderr, "");
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out[0]).result.tools, s.listTools());
  } finally { await s.close(); }
});

test("a symlinked install path still runs the bridge (main check compares real paths)", async () => {
  const s = service();
  const port = await s.listen();
  const link = join(mkdtempSync(join(tmpdir(), "studio-bridge-link-")), "bridge");
  symlinkSync(BRIDGE_DIR, link, "dir");
  try {
    const r = await run({ STUDIO_TOKEN: s.token, STUDIO_PORT: String(port) }, [rpc(1, "tools/list")], 1, { script: join(link, "index.js") });
    assert.equal(r.code, 0);
    assert.equal(r.out.length, 1, "no reply means main() never ran: the silent exit-0 bug");
    assert.deepEqual(JSON.parse(r.out[0]).result.tools, s.listTools());
  } finally { await s.close(); }
});

test("a notification gets no reply line: the only line out is the ping reply", async () => {
  const s = service();
  const port = await s.listen();
  try {
    const r = await run({ STUDIO_TOKEN: s.token, STUDIO_PORT: String(port) }, [rpc(undefined, "notifications/initialized"), rpc(1, "ping")], 1);
    assert.equal(r.out.length, 1, r.stdout);
    assert.equal(JSON.parse(r.out[0]).id, 1);
  } finally { await s.close(); }
});

test("a 302 from the loopback Service is refused and its target never receives the token", async () => {
  let hits = 0;
  const target = createServer((_q, res) => { hits++; res.end("{}"); });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const tport = (target.address() as { port: number }).port;
  const redirector = createServer((_q, res) => { res.writeHead(302, { location: `http://127.0.0.1:${tport}/mcp` }); res.end(); });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  const rport = (redirector.address() as { port: number }).port;
  const token = "tok-redirect-test";
  try {
    const r = await run({ STUDIO_TOKEN: token, STUDIO_PORT: String(rport) }, [rpc(4, "ping")], 1);
    assert.equal(hits, 0, "the redirect target must receive nothing");
    assert.equal(JSON.parse(r.out[0]).id, 4);
    assert.match(JSON.parse(r.out[0]).error.message, /Cannot reach/);
    assert.ok(!r.stdout.includes(token));
  } finally { target.close(); redirector.close(); }
});

test("a token pasted with surrounding whitespace still authenticates", async () => {
  const s = service();
  const port = await s.listen();
  try {
    const r = await run({ STUDIO_TOKEN: `  ${s.token}\n`, STUDIO_PORT: String(port) }, [rpc(1, "tools/list")], 1);
    assert.deepEqual(JSON.parse(r.out[0]).result.tools, s.listTools());
  } finally { await s.close(); }
});

test("a call that fails after stdin closes stays silent (no error line during shutdown)", async () => {
  const dropper = createServer((req) => req.socket.destroy());
  await new Promise<void>((r) => dropper.listen(0, "127.0.0.1", r));
  const port = (dropper.address() as { port: number }).port;
  try {
    const r = await run({ STUDIO_TOKEN: "tok-closing-test", STUDIO_PORT: String(port) }, [rpc(5, "ping")], 0);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  } finally { dropper.close(); }
});

test("manifest matches the MCPB node-server shape and keeps the token sensitive", () => {
  const m = JSON.parse(readFileSync(join(REPO_ROOT, "studio-runner/bridge/manifest.json"), "utf8"));
  for (const k of ["manifest_version", "name", "version", "description", "author", "server"]) assert.ok(m[k], k);
  assert.equal(m.server.type, "node");
  assert.equal(m.server.entry_point, "index.js");
  assert.deepEqual(m.server.mcp_config.args, ["${__dirname}/index.js"]);
  assert.equal(m.user_config.token.sensitive, true);
  assert.equal(m.user_config.token.required, true);
  assert.equal(m.server.mcp_config.env.STUDIO_TOKEN, "${user_config.token}");
  assert.equal(m.user_config.port.type, "number");
  assert.ok(!JSON.stringify(m).match(/https?:\/\/(?!127\.0\.0\.1)/), "no remote URL in the manifest");
});
