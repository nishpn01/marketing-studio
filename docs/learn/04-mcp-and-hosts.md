# 4. MCP and hosts

The Marketing Studio does not ship its own chat window. You talk to it through a host you already use: Claude Code, Codex, or another MCP client. This chapter explains the connection and what the host is allowed to do.

## What MCP is

Model Context Protocol is a small JSON-RPC interface. A client sends requests, a server answers. The methods that matter here are `initialize`, `tools/list`, and `tools/call`. There are also `prompts/list` and `prompts/get` on the Service.

Two things vary between MCP servers: the transport and the authorization.

This repository has two servers.

**Local stdio.** [`studio-runner/src/mcp-stdio.ts`](../../studio-runner/src/mcp-stdio.ts) reads one JSON object per line from stdin and writes one per line to stdout. It has no network listener, no authentication, and no tenant registry. Anyone who can start the process has the access the process was started with.

**Service HTTP.** [`studio-runner/src/service/studio-service.ts`](../../studio-runner/src/service/studio-service.ts) exposes `/mcp` over local HTTP and adds prompts. It still binds to `127.0.0.1`.

## The workspace is fixed at start

The local server takes its workspace and its tool allowlist from the command line:

```sh
studio-runner/bin/studio-mcp --workspace <business-workspace> --tools session_status,context_search
```

Both arguments are required. An unknown tool name, a missing workspace, or a bad business profile refuses to start. A request cannot name a different workspace, choose a file path, or widen the allowlist. Source [`mcp-stdio.ts`](../../studio-runner/src/mcp-stdio.ts) rejects extra arguments and caps request size at 64 KiB.

The tools themselves are deliberately narrow. [`studio-runner/src/local-tools.ts`](../../studio-runner/src/local-tools.ts) exposes `session_status`, `context_search`, `improvement_list`, `capture_list`, `capture_show`, and optionally `session_start`. There is no run, no approval, no disclosure grant, and no publish tool.

`session_status` returns a field allowlist: session slug, state, evidence count, restricted evidence count, notes count, whether a direction is approved, and a small run object with status, version, and open blocker count. It does not return the owner's idea text, evidence paths, or direction prose. A host can see that work exists without reading the private content. Evidence: [`local-tools.ts`](../../studio-runner/src/local-tools.ts:19-20); [`test/mcp-stdio.test.ts`](../../studio-runner/test/mcp-stdio.test.ts:72-77).

## Prompts, not just tools

The Service adds six Director prompts in [`studio-runner/src/service/mcp-prompts.ts`](../../studio-runner/src/service/mcp-prompts.ts):

- `resume_session` recovers a saved session.
- `discuss_brainstorm` grounds discussion in tenant context.
- `propose_direction` turns a discussed direction into a pending inbox request.
- `produce` starts a Service-managed job, but only with a signed direction approval.
- `review` inspects a job without changing it.
- `proactive_scan` hands the host the bounded, host-scheduled Git/run digest and idea-submission instructions.

The distinction matters. A tool can act. A prompt hands the host a structured instruction. Neither can write authority. Runtime dispatch is an allowlist of safe local tools plus seven named request, run, status, and proactive handlers; unknown authority-shaped names fall through to `DENIED`.
 `AUTHORITY_TOOL_DENYLIST` is exported and used by tests, not consulted by the dispatcher. Evidence: [`studio-service.ts`](../../studio-runner/src/service/studio-service.ts:47-56,627-702,705-792).

## Bring your own AI, no API key

The CLI and Service use local subscription adapters through `ModelPort`. The Service path queues a run using the provider persisted in the tenant record; fixture is the default, while `claude-code-cli` and `codex-cli` require the corresponding first-party subscription login. Evidence: [`model-port.ts`](../../studio-runner/src/model-port.ts:45-145); [`studio-service.ts`](../../studio-runner/src/service/studio-service.ts:730-782); [`mcp-prompts.ts`](../../studio-runner/src/service/mcp-prompts.ts:61-69).

[`docs/engineering/ADR-003-model-provider-policy-reversal.md`](../engineering/ADR-003-model-provider-policy-reversal.md) records the earlier policy choice. Subscription-only local draft work is now supported by the named adapters; API-backed ModelPort remains deferred. `modelFor` has no default and no fallback.

Remote hosts are not connected. ChatGPT and Claude Chat cannot reach a local stdio process, and this repository has no authenticated remote MCP transport. [`docs/hosts/LOCAL-TOOL-INTERFACE.md`](../hosts/LOCAL-TOOL-INTERFACE.md) says not to put the local server behind a tunnel to fake it. Doing so would expose a workspace with no principal mapping and no rate limits.

## Three boundaries

- Unauthenticated local stdio: `studio-mcp` over stdin/stdout, workspace fixed at start, no network, no tenant registry.
- Bearer-token, origin, and rate-limited Service `/mcp`: local HTTP on 127.0.0.1, adds prompts and queued tenant-configured runs (fixture by default).
- Passkey and CSRF-protected owner Inbox `/inbox`: the only path that writes authority records.

## Try it yourself

Create a tiny business workspace, then speak raw JSON-RPC to the local server:

```sh
mkdir -p /tmp/studio-mcp/docs
printf '# Style\nWrite plainly.\n' > /tmp/studio-mcp/docs/style.md
cat > /tmp/studio-mcp/studio-business.json <<'JSON'
{"schema_version":"studio.business/0.1","workspace_id":"demo","allowed_roots":["/tmp/studio-mcp"],
 "defaults":{"audience":"owners","provider":"claude-code-cli",
 "models":{"director":"sonnet","writer":"sonnet","fact_reviewer":"sonnet","craft_reviewer":"sonnet"},
 "budget":{"max_model_calls":12,"max_steps":40,"max_revision_rounds":1}},
 "catalog":[{"id":"style","path":"/tmp/studio-mcp/docs/style.md","visibility":"approved","description":"Style"}]}
JSON

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| studio-runner/bin/studio-mcp --workspace /tmp/studio-mcp --tools session_status,context_search
```

You get two JSON lines. The first is the server identity and protocol version. The second lists exactly the two tools you allowed, with their input schemas. No run was started, no model was called, and nothing outside `/tmp/studio-mcp` was readable.

Next: [packs and specialists](05-packs-and-specialists.md).
