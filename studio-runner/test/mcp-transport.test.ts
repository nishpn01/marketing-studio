import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudioService } from "../src/service/studio-service.ts";
import { TestOwnerVerifier } from "./helpers/test-owner-verifier.ts";
import { sourceWorkspace } from "./helpers/service-fixture.ts";

const owner = new TestOwnerVerifier();
const service = (tenantId: string, extra: object = {}) =>
  new StudioService({ dataRoot: mkdtempSync(join(tmpdir(), "studio-transport-")), tenantId, workspace: sourceWorkspace(), ownerVerifier: owner, ...extra });

function call(port: number, method: string, token: string | null, body?: unknown) {
  return new Promise<{ status: number; headers: Record<string, any>; text: string }>((ok, fail) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...(token ? { authorization: "Bearer " + token } : {}) } }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (out += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, text: out }));
    });
    req.on("error", fail);
    req.end(text);
  });
}
const rpc = (id: number | undefined, method: string, params?: object) => ({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });

test("401 carries a Bearer challenge for missing and wrong tokens", async () => {
  const s = service("transport-401");
  const port = await s.listen();
  try {
    for (const token of [null, "wrong"]) {
      const r = await call(port, "POST", token, rpc(1, "ping"));
      assert.equal(r.status, 401);
      assert.match(r.headers["www-authenticate"], /^Bearer realm="marketing-studio"$/);
      assert.ok(!r.headers["www-authenticate"].includes("resource_metadata"), "no OAuth metadata exists yet");
    }
  } finally { await s.close(); }
});

test("a notification gets 202 with no body and never runs a tool", async () => {
  const s = service("transport-202");
  const port = await s.listen();
  try {
    const init = await call(port, "POST", s.token, rpc(undefined, "notifications/initialized"));
    assert.equal(init.status, 202);
    assert.equal(init.text, "");
    // Same shape as a tools/call without an id: accepted, but it must not create a session.
    const quiet = await call(port, "POST", s.token, rpc(undefined, "tools/call", { name: "session_start", arguments: { idea: "must not be created", slug: "no-such-session" } }));
    assert.equal(quiet.status, 202);
    const listed = await call(port, "POST", s.token, rpc(2, "tools/call", { name: "session_status", arguments: {} }));
    assert.equal(JSON.parse(JSON.parse(listed.text).result.content[0].text).length, 0);
    // A request with an id still gets a JSON-RPC response.
    assert.equal(JSON.parse((await call(port, "POST", s.token, rpc(3, "ping"))).text).id, 3);
  } finally { await s.close(); }
});

test("GET and DELETE on /mcp are 405 with Allow: POST", async () => {
  const s = service("transport-405");
  const port = await s.listen();
  try {
    for (const method of ["GET", "DELETE"]) {
      const r = await call(port, method, s.token);
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, "POST");
    }
  } finally { await s.close(); }
});

test("initialize echoes a supported protocolVersion and falls back for unknown ones", async () => {
  const s = service("transport-version");
  const port = await s.listen();
  try {
    const version = async (v?: string) => JSON.parse((await call(port, "POST", s.token, rpc(1, "initialize", v === undefined ? {} : { protocolVersion: v }))).text).result.protocolVersion;
    assert.equal(await version("2025-06-18"), "2025-06-18");
    assert.equal(await version("2025-03-26"), "2025-03-26");
    assert.equal(await version("2024-11-05"), "2024-11-05");
    assert.equal(await version("1999-01-01"), "2025-06-18");
    assert.equal(await version(), "2025-06-18");
  } finally { await s.close(); }
});

test("every tool carries all three annotation hints, and write tools are never marked read-only", async () => {
  // linear-review adds linear_review_marker, so list both tenant policies.
  for (const [id, extra] of [["transport-tools-passkey", {}], ["transport-tools-linear", { reviewPolicy: "linear-review", linearAccountId: "owner@example.com" }]] as const) {
    const s = service(id, extra);
    const port = await s.listen();
    try {
      const tools = JSON.parse((await call(port, "POST", s.token, rpc(1, "tools/list"))).text).result.tools;
      assert.ok(tools.length > 20);
      for (const t of tools) {
        assert.deepEqual(Object.keys(t.annotations).sort(), ["destructiveHint", "idempotentHint", "readOnlyHint"], t.name);
        for (const k of Object.keys(t.annotations)) assert.equal(typeof t.annotations[k], "boolean", t.name + "." + k);
      }
      const readOnly = tools.filter((t: any) => t.annotations.readOnlyHint).map((t: any) => t.name).sort();
      assert.deepEqual(readOnly, ["ideas_list", "improvement_list", "linear_sync_status", "piece_status", "proactive_context", "program_plan_status", "run_status", "session_status", "context_search"].sort());
      for (const name of ["session_start", "run_start", "idea_submit", "piece_final_request", "request_direction_approval", "program_plan_save"])
        assert.equal(tools.find((t: any) => t.name === name).annotations.readOnlyHint, false, name);
    } finally { await s.close(); }
  }
});
