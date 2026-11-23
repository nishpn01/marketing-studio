# Local tool interface: implementation and boundaries

`studio-runner/src/local-tools.ts` provides an in-process, provider-neutral boundary around existing legacy CLI commands. A trusted embedding process constructs `createLocalTools(workspace, allowedTools)` using a canonical, explicitly selected workspace and fixed method allowlist. It receives versioned `studio.tool-call/0.1` objects and returns a result or a generic error without exposing local exception text. The request cannot choose another workspace, a filesystem path, permissions, credentials, a model provider, or an approval. This stdio surface is separate from the loopback Studio Service MCP described in [Architecture](../ARCHITECTURE.md).

Available operations are `session_status`, `context_search`, `improvement_list`, `capture_list`, `capture_show`, and, only when separately allowed, `session_start`. `list()` provides tool descriptions and input schemas. These use the existing Director functions and their privacy rules, including restricted-capture and source containment. They do not provide production runs, source grants, unrestricted transcript access, model invocation, owner approvals, publishing, or account changes. Context search returns untrusted guidance or conversation records, not evidence.

## Security boundary

The dispatcher is an **in-process library**; its only transport is the local stdio server below, not a network service. It has no listener, authenticated identity, tenant registry, per-user or per-session authorization, network transport, rate limiting, or operating-system sandbox. The embedding application and its configured workspace/policy are trusted. `session_status` returns only a field allowlist (session slug, state, evidence/note counts, whether a direction is approved, run status, version and open-blocker count); it no longer returns idea text, evidence or note paths, direction prose or package paths. Improvement listing may still return titles and change references. Method allowlisting does not provide field-level authorization. A local caller with filesystem access can bypass this dispatcher. Exposing it remotely before implementing and independently reviewing authentication, authorization and tenant isolation would expose private workspace data. The service must not treat an LLM's choice of tool, an owner quote, or a claimed workspace ID as authenticated owner authorization. Remote hosting must resolve a principal to an authorized workspace and action set server-side, constrain request and response sizes, and preserve consent and privacy independently of tool arguments.

Existing local owner approval is unauthenticated and is not a publication authorization. Restricted-source clearance remains a separate workstream; this interface does not relax the restricted-source gate. Arbitrary source text and retrieved passages are data, not instructions.

## Local stdio MCP server

`studio-runner/bin/studio-mcp --workspace <business workspace> --tools <name,name,...>` (source `src/mcp-stdio.ts`) wraps `createLocalTools` as a minimal MCP server: JSON-RPC 2.0, one JSON message per line on stdin/stdout, methods `initialize`, `ping`, `tools/list`, `tools/call` (notifications are ignored). No network, no HTTP, no dependencies, no authentication.

- The workspace and tool allowlist come only from the command line at process start. `--tools` is required (no default) and an unknown tool name or bad workspace refuses to start. Requests cannot name a workspace, path or permission; extra arguments are rejected.
- Requests over 64 KiB, malformed JSON and invalid shapes get generic JSON-RPC errors; tool failures return `isError` with only a code (`INVALID_REQUEST`, `DENIED`, `OPERATION_FAILED`), never local exception text or paths.
- Restricted captures and sources keep the existing gates because the same functions run underneath.
- Anyone who can spawn the process has the access it was started with. It is a local-user convenience, not a security boundary.

Register it as a local server (replace paths; use the least tools you need, e.g. read-only):

    # Claude Code (writes a project .mcp.json; Claude Code asks you to approve project servers)
    claude mcp add -s project studio-local -- "<core>/studio-runner/bin/studio-mcp" --workspace "<workspace>" --tools session_status,context_search

    # Codex
    codex mcp add studio-local -- "<core>/studio-runner/bin/studio-mcp" --workspace "<workspace>" --tools session_status,context_search

    # Codex config.toml equivalent
    [mcp_servers.studio-local]
    command = "<core>/studio-runner/bin/studio-mcp"
    args = ["--workspace", "<workspace>", "--tools", "session_status,context_search"]

Verified: offline tests exercise the server over a real stdio pipe, and a **fresh Claude Code session connected to the local MCP server**, exposed its configured allowlisted tools, and called `session_status` and `context_search` against a synthetic workspace. A non-allowlisted tool was refused by a direct JSON-RPC test. **Not verified:** a live Codex MCP session. See [host acceptance evidence](../operations/HOST-ACCEPTANCE.md).

### ChatGPT and claude.ai chat are NOT connected

Claude desktop can start this stdio server locally (see [ANYWHERE.md](../ANYWHERE.md), NOT RUN). ChatGPT, claude.ai on the web and the phone app cannot reach a local stdio process. Connecting either would require: an authenticated remote MCP transport (HTTP with OAuth or equivalent), a server-side mapping from the authenticated principal to one authorized workspace and tool set (tenant mapping), request/response limits and rate limiting, and an independent security review before any real workspace is exposed. None exist here. The stdio server is never tunneled or proxied to approximate them; remote access is planned only through the approved remote-gateway design ([owner policy](../operations/AUTHORITY-AND-CAPABILITY-STATUS.md#owner-policy-2026-11-14)).

## Platform interoperability (investigated, not connected)

OpenAI documents [custom MCP servers for ChatGPT](https://developers.openai.com/api/docs/guides/custom-mcp-server) and a [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) for supported private-server scenarios. Claude documents [custom remote MCP connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), where the connection originates from Anthropic's infrastructure. A compatible authenticated MCP transport, platform configuration, an appropriate reachable endpoint or supported tunnel, and owner-authorized account setup remain necessary; none were configured or tested here. Platform availability and plan requirements must be rechecked at setup time. No local workspace is exposed by this change.

## Provider boundary

`claude-code-cli` uses the local Claude CLI. Before a model call it checks the CLI-reported authentication status is a first-party claude.ai login, refuses `ANTHROPIC_API_KEY`, and runs the child with an allowlisted environment rather than forwarding unrelated provider secrets. Role instructions are passed via a mode-0600 file in a private temporary directory, not command-line arguments; cleanup runs on normal completion or caught failures. A force-killed process can leave that file behind. The child still runs with the local operator's operating-system identity and can access that user's home and Claude authentication files; environment filtering is not filesystem or credential isolation. An executable configured by the local operator and a compromised CLI can misreport its status. The Runner cannot independently verify a subscription's billing arrangements and does not claim a fixed cost. The adapter is tested with a synthetic CLI stub, not a separately billed API.

Codex and Claude Code can be conversation hosts separately from the model provider. The named subscription adapters run with explicit no-tool/read-only controls and reject their API-key environments; a tenant must select the provider explicitly and the Service defaults to fixtures. `modelFor` accepts `claude-code-cli` and `codex-cli`; every other name raises `ProviderError`, with no default or fallback. Offline tests continue to inject the existing `FixtureModel`.
