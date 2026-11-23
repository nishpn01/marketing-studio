# Use the Studio from your phone or Claude desktop

Still laptop-only, subscription-only and no publishing. Nothing here opens a port to the internet or adds a token. Official pages are linked at the end of each section; they were read on 2026-11-14 and may change.

**Not run:** none of the steps below were run on a real phone, Claude desktop or a Pro/Max login. Every step is marked NOT RUN until the owner reports a result.

## What works where

| Where you are | Reaches the Studio today? | How |
| --- | --- | --- |
| Claude Code in the terminal on the laptop | Yes | [Getting started](GETTING-STARTED.md#6-install-into-your-app) |
| Claude app on your phone, or claude.ai/code in a browser, steering a Claude Code session on the laptop | Yes (NOT RUN) | Remote Control, below |
| Claude desktop chat | Yes, the full Service tool list (NOT RUN) | `studio-bridge` extension, below. Or limited local tools only via stdio `studio-mcp` |
| claude.ai chat, the phone app's normal chat, Cowork sessions that run in the cloud | **Not yet** | Anthropic's cloud calls connectors itself, so it cannot reach `127.0.0.1`. Planned only through the approved remote-gateway design (tunnel plus OAuth), after the separate-user install (the tracked authority milestone); see the [owner policy](operations/AUTHORITY-AND-CAPABILITY-STATUS.md#owner-policy-2026-11-14) |
| Cowork session running locally | Unknown. Test and report (NOT RUN) | Install the `studio-bridge` extension, then see the Cowork test below. The docs and a third-party post disagree |

Do not point a tunnel at the Service or at `studio-mcp` to get claude.ai working; only the approved gateway design may be tunneled (see the [owner policy](operations/AUTHORITY-AND-CAPABILITY-STATUS.md#owner-policy-2026-11-14)). The Service accepts only `Host: 127.0.0.1`, uses one static bearer token, and has no OAuth. See [Architecture](ARCHITECTURE.md).

## Use the Studio from your phone (Remote Control)

Remote Control lets the Claude app or claude.ai/code steer a Claude Code session that keeps running on your laptop. The session keeps its local MCP servers, so it still talks to the Service on `127.0.0.1`. Claude Code makes outbound HTTPS calls only and opens no inbound port.

Needs: a Pro, Max, Ultra, Team or Enterprise subscription login (`/login` through claude.ai). **API keys are not supported for owner runs**, per the [owner policy](operations/AUTHORITY-AND-CAPABILITY-STATUS.md#owner-policy-2026-11-14). On Team and Enterprise an Owner must enable the toggle first.

1. Finish [Getting started](GETTING-STARTED.md) steps 1 to 6 (Service running, `STUDIO_TOKEN` exported, Claude Code installed into `~/studio-host`).
2. In a second terminal (with `STUDIO_TOKEN` exported), start Claude Code with Remote Control. Either:

   ```sh
   cd "$HOME/studio-host" && claude --remote-control "Studio"
   ```

   or start `claude` normally and type `/remote-control` (alias `/rc`). Accept the one-time Remote Control confirmation.
3. The terminal shows a session URL and a QR code (run `/remote-control` again to see them). Scan it with the Claude app, or open claude.ai/code and pick the session. No Claude app yet? Run `/mobile` for a store link.
4. From the phone, type the same prompts as in [Getting started step 8](GETTING-STARTED.md#8-your-first-session-start-a-newsletter-series-about-the-studio). Idea capture from the phone is `session_start` through the Director.

Status: **NOT RUN.** Not checked: the connection itself, MCP tools being usable from the phone, and whether `/remote-control` works with the project-scoped MCP server and `${STUDIO_TOKEN}`.

Limits to know:
- The laptop must be awake and Claude Code must keep running. Sleep pauses it and it reconnects when the laptop wakes.
- The phone is only a window. **Owner approvals still happen in the Studio Inbox at `http://localhost:8765/inbox` on the laptop with Touch ID.** That page is never exposed, so you cannot approve a plan or final from the phone.
- Remote Control is unavailable when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `CLAUDE_CODE_DISABLE_FEATURE_FLAGS` is set, and for Zero Data Retention organizations. Setting only `DISABLE_TELEMETRY` or `DO_NOT_TRACK` keeps it available unless your organization requires Trusted Devices; with either set, use Claude Code v2.1.283 or later (v2.1.304 or later in the Claude Desktop app).
- Stopping the session ends phone access. Disable it for good with the `disableRemoteControl` setting.

Official: [Remote Control](https://code.claude.com/docs/en/remote-control).

## Use the Studio from Claude desktop (bridge extension)

`studio-bridge` is a Claude desktop extension (`.mcpb`) that forwards MCP over stdio to the Service at `http://127.0.0.1:<port>/mcp`. Nothing is exposed to the internet and nothing is added to the Service: the bridge only attaches your token, refuses any URL that is not `http://127.0.0.1:<port>/mcp`, never prints the token, and relays the Service's tool list unchanged. Every auth and authority check still happens in the Service. Source: [`studio-runner/bridge/`](../studio-runner/bridge/index.js).

What works: whatever tools the Service exposes, such as `session_start`, `session_status` and the status tools. Not available: the Inbox. **Approvals still happen at `http://localhost:8765/inbox` on the laptop with Touch ID.** A desktop chat is not a Claude Code session, so the Director skills and permission rules do not apply. The laptop must be awake and the Service running.

1. Start the Service ([Getting started](GETTING-STARTED.md) steps 1 to 5) and read your token: `cat "$HOME"/.studio-service/tenants/*/token`.
2. Build the extension (needs Node and network once, for the official packer):

   ```sh
   npx --yes @anthropic-ai/mcpb@2.1.2 pack studio-runner/bridge studio-bridge.mcpb
   ```

   This validates `manifest.json` against the MCPB schema and writes a 3-file archive (`index.js`, `manifest.json`, and `package.json` with `"type": "module"`, so Node runs `index.js` as ESM even without a parent package.json). It has no dependencies.
3. In Claude desktop open **Settings > Extensions > Advanced settings > Install Extension…** and pick `studio-bridge.mcpb` (double-click or drag-and-drop also work).
4. In the install dialog paste the token into **Studio token** (marked sensitive, so Claude desktop stores it for you and it is not written to this repo) and keep or change **Studio Service port** (default 8765). Enable the extension.
5. Open a new chat. The Studio tools should appear in the tools menu. Try "What Studio sessions do I have?" (`session_status`).

Status: **NOT RUN** in Claude desktop. Checked offline against the fixture Service (`studio-runner/test/studio-bridge.test.ts`): tool list and tool call round-trip, 401 on a wrong token, non-loopback refusal, redirects not followed, token absent from stdout and stderr, the packed folder run from a temp dir with ESM detection disabled (the Node 20.3 case), and a symlinked install path. Also run: the official `mcpb validate` and `mcpb pack` (v2.1.2) on the manifest. Not checked: the install dialog, whether Desktop stores the token in the OS keychain, and which Node Desktop launches (the manifest allows 20.3 or later; CI runs Node 22 and 26).

If the extension shows an error: `401` in a tool result means the pasted token is wrong or the Service was restarted with a new tenant; "Cannot reach the Studio Service" means the Service is not running on that port.

### Cowork, locally running: test and report (NOT RUN)

Whether a local Cowork session can use desktop extensions is not established (the support article says local sessions can use local servers; a March 2026 third-party post describes an undocumented bridge). To find out, with the extension installed and enabled:

1. Start a Cowork session that runs **locally** on the laptop, not a cloud one.
2. Ask it to call `session_status`.
3. Report: tools visible yes/no, call worked yes/no, and the exact error text if any.

Until someone reports, treat Cowork as **unknown**. Do not point a Cowork cloud session at the bridge; it cannot reach your laptop.

Official (read 2026-11-16): [Build a desktop extension with MCPB](https://claude.com/docs/connectors/building/mcpb.md), [MCPB manifest spec](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md) (`user_config`, `sensitive`, `${user_config.KEY}` env substitution).

## Use the Studio from Claude desktop (limited local tools)

Claude desktop chat can start a **local stdio** server on your laptop. The Studio has one: `studio-mcp`. It is *not* the Service. It has no inbox, no programs, no runs and no Linear change sets, because those live in the Service.

Exactly which tools it can offer (you pick the subset with `--tools`; there is no default):

| Tool | What it does | Suggested |
| --- | --- | --- |
| `session_status` | Session slug, state and counts only | Yes |
| `context_search` | Search approved workspace sources (guidance, not evidence) | Yes |
| `improvement_list` | List saved improvement proposals | Optional |
| `capture_list` | List conversation captures | Optional |
| `capture_show` | Read a bounded excerpt of an *approved* capture | Leave off |
| `session_start` | Save a new idea as a discussion session | Optional, this is idea capture |

Nothing here approves, drafts, runs a model, publishes or calls Linear. See [local tool interface](hosts/LOCAL-TOOL-INTERFACE.md).

1. In Claude desktop open **Settings > Developer > Edit Config**. On macOS the file is `~/Library/Application Support/Claude/claude_desktop_config.json`.
2. Add a stdio entry. Use absolute paths; replace `<core>` and `<workspace>` (for example `$STUDIO_CORE` and `$STUDIO_WORKSPACE` from Getting started):

   ```json
   {
     "mcpServers": {
       "studio-local": {
         "command": "<core>/studio-runner/bin/studio-mcp",
         "args": ["--workspace", "<workspace>", "--tools", "session_status,context_search,session_start"]
       }
     }
   }
   ```

3. Quit Claude desktop completely and reopen it. Check the connectors list in the chat box for `studio-local`.

Status: **NOT RUN.** Not checked: Desktop launching the script (`studio-mcp` runs `node` from `PATH`, and a GUI app may not see your shell's `PATH`; if the logs in `~/Library/Logs/Claude/mcp-server-studio-local.log` say `node: not found`, point `command` at a small wrapper that sets `PATH`). The server itself is covered by offline tests and a real Claude Code session ([host acceptance](operations/HOST-ACCEPTANCE.md), row 6).

Notes:
- This is a local-user convenience, not a security boundary: whoever can run the process has the access it was started with.
- This is the alternative to the bridge when you want only the local, workspace-reading tools and no Service. It has no token.
- A desktop chat is not a Claude Code session. The Director skills and permission rules from the installer do not apply there.

Official: [MCP: connect to local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers) (config file and menu path), [MCPB for Claude desktop](https://claude.com/docs/connectors/building/mcpb.md).

## Later: claude.ai, phone chat and Cowork in the cloud

These surfaces call a remote connector from Anthropic's infrastructure, so the Studio would need a public HTTPS hostname on port 443 and OAuth (or a stored header, in beta for some organizations). Loopback and private addresses are refused ([connector troubleshooting](https://claude.com/docs/connectors/building/troubleshooting.md#hostname-resolves-to-a-private-ip), [authentication](https://claude.com/docs/connectors/building/authentication.md), [custom connectors](https://claude.com/docs/connectors/custom/add-unlisted.md)). The plan is a narrow gateway with a tool allowlist behind a tunnel, **only after** the separate-user install, because a public listener raises the attacker from a local process to anyone on the internet. Until then use Remote Control.

The Service now answers the transport details such a connector needs (a `WWW-Authenticate: Bearer` challenge on 401, 202 for notifications, 405 on `GET /mcp`, and tool annotations), but it has no OAuth and is still loopback-only.
