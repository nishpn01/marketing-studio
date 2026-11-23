# Getting started: your first real series

This guide takes you from a fresh laptop to a real newsletter series, reviewed as Linear docs. Copy and paste the commands in order.

**Ground rules (owner policy):**

- The [owner policy](operations/AUTHORITY-AND-CAPABILITY-STATUS.md#owner-policy-2026-11-14) applies: laptop only, subscription-only (no API key), nothing publishes.
- The Studio never holds a Linear token. Your app's own Linear connector does the Linear work.

**Not ready for private or sensitive data.** Use public docs or nonsensitive material until the [separate-user install](operations/SEPARATE-USER-INSTALL.md) has been run and verified on your machine (the script exists; the live run is not done). See [what is ready](../README.md#what-works-today).

## How each step was checked

Each command below was run on a clean release checkout with a temp `HOME`, a temp workspace and public docs only. Steps I could not run are marked **NOT RUN**:

| Not run | Why |
| --- | --- |
| Touch ID / passkey ceremony | Needs a human at a browser with Touch ID |
| Live Linear (plans, docs, comments, marker) | Needs your Linear login in the app |
| Live model drafting (`claude-code-cli` / `codex-cli` provider) | Spends subscription usage; owner acceptance run pending |
| An interactive Claude Code or Codex chat session | Needs your app login |
| Scheduled task | Created inside your app |

What I did run: `studio doctor`, workspace creation, context search, Service start, token, MCP calls, both installers, Codex MCP registration, `claude mcp list`, and the first Director steps (`session_start`, `work_shape_propose`, `program_shape_confirm`).

## 1. Prerequisites

| Need | Check |
| --- | --- |
| Git | `git --version` |
| Node 26 (22.16 also works) | `node --version` |
| Python 3 | `python3 --version` |
| Claude Code and/or Codex, logged in with your subscription | `claude --version` / `codex --version` |
| A Linear workspace connected in your app (step 7) | Needed only for series review |

Do not set `ANTHROPIC_API_KEY` or a Codex API key. The Studio refuses them.

## 2. Clone and check

```sh
# In GitHub, click Code and copy this repository's URL; or unpack a source archive.
git clone <repository-url-from-GitHub> ~/marketing-studio-core
cd ~/marketing-studio-core
export STUDIO_CORE="$PWD"
"$STUDIO_CORE/studio-runner/bin/studio" doctor
```

If you received an archive instead, unpack it, enter the checkout directory, and set `STUDIO_CORE` to that path. Use the reviewed release contents; this local install step does not publish anything.

Expected: JSON that ends with `"publish_available": false` and `"anthropic_api_key_set": false`. Your `claude_cli` and `codex_cli` versions show if installed. `"live_provider_available": false` is normal here.

## 3. Create your workspace

The workspace is your private folder of sources and settings. Keep it **outside** the clone. It needs two files: `studio-workspace.json` (identity) and `studio-business.json` (sources and defaults). The ready template for "the Studio about itself" uses this repo's public docs as sources.

```sh
export STUDIO_WORKSPACE="$HOME/studio-workspaces/studio-self"
mkdir -p "$STUDIO_WORKSPACE"
cp "$STUDIO_CORE/templates/workspace/studio-self/studio-workspace.json" "$STUDIO_WORKSPACE/"
sed "s#/ABSOLUTE/PATH/TO/marketing-studio-core#$STUDIO_CORE#" \
  "$STUDIO_CORE/templates/workspace/studio-self/studio-business.json" > "$STUDIO_WORKSPACE/studio-business.json"

"$STUDIO_CORE/studio-runner/bin/studio" context-search --workspace "$STUDIO_WORKSPACE" --query roadmap
```

Expected: results from the `roadmap` and `readme` sources. No model runs.

For your own business later, copy [`templates/workspace/studio-business.example.json`](../templates/workspace/studio-business.example.json) and follow [the template notes](../templates/workspace/studio-self/README.md). The `workspace_id` must match in both files. Every catalog file must sit inside `allowed_roots`.

### Choose the review policy now

This decides how a series piece becomes final. **It is fixed at first Service start.** To change it later, use a new `--data-root` and start again (old state stays on disk).

| Policy | Final needs | Use when |
| --- | --- | --- |
| `passkey` (default) | Touch ID in the Studio Inbox, bound to the exact draft, QA result and Linear revision | You want a real identity check. This is the only policy that can ever satisfy a future publish step |
| `linear-review` | A marker comment from one named Linear account (`/studio approve-plan <program>`, `/studio final <piece>`) | You want less friction. The marker is recorded as **unauthenticated**. Never publish-eligible |

Under both policies: failing or blocked fact or craft QA cannot be finalized, and a final never publishes.

## 4. Start the Service and export the token

The Service is a local program on `127.0.0.1`. Run it in its own terminal and leave it open.

Default (`passkey`):

```sh
"$STUDIO_CORE/studio-runner/bin/studio-service" \
  --data-root "$HOME/.studio-service" --tenant studio-self \
  --workspace "$STUDIO_WORKSPACE" --port 8765
```

Or `linear-review` (use your Linear account id or email):

```sh
"$STUDIO_CORE/studio-runner/bin/studio-service" \
  --data-root "$HOME/.studio-service" --tenant studio-self \
  --workspace "$STUDIO_WORKSPACE" --port 8765 \
  --review-policy linear-review --linear-account you@example.com
```

For real drafting with your subscription, add `--provider claude-code-cli` (or `codex-cli`) on this first start. Without it the Service uses the offline **fixture** provider, which writes canned text. That is right for a dry run. Live drafting is **NOT RUN** here.

The Service prints three things:

```text
Studio Service listening on 127.0.0.1:8765
Token: <path to the token file>
Owner inbox: http://localhost:8765/inbox
No owner passkey yet. Open http://localhost:8765/inbox/setup and enter this one-time code within 10 minutes: <code>
```

In a **second** terminal, export the token. The easy way is to read the only token file under the data root:

```sh
export STUDIO_TOKEN="$(cat "$HOME"/.studio-service/tenants/*/token)"
```

Check it works (`401` without the token, `200` with it):

```sh
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8765/mcp \
  -H "authorization: Bearer $STUDIO_TOKEN" -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}'
```

Next time, start with only `--data-root`, `--tenant` and `--port`. The workspace is already copied. The token stays the same, so you export it again in each new terminal.

## 5. Register your passkey (Touch ID) — NOT RUN

Open `http://localhost:8765/inbox/setup` in your browser. Enter the one-time code from the Service terminal. Follow the browser's Touch ID prompt. This creates your owner passkey. I checked that the page loads (HTTP 200). I did not do the ceremony.

The code lasts 10 minutes. If it expired, type `setup` and press Enter in the Service terminal for a new one. (Not run: my test Service had no terminal attached.) If a passkey already exists, no code is needed.

Do this even if you plan to use `linear-review`. The Inbox is where you approve directions and disclosure requests, and a passkey is needed for it.

## 6. Install into your app

Make a folder to open the app in. It holds only the installed skills and the MCP entry. Use the same `STUDIO_PORT` as the Service if you changed it.

```sh
mkdir -p "$HOME/studio-host"
```

### Claude Code

```sh
mkdir -p "$HOME/studio-host/.claude"
sh "$STUDIO_CORE/hosts/claude-code/install.sh" "$HOME/studio-host/.claude" studio-self "$STUDIO_WORKSPACE"
```

This installs two skills (`marketing-director`, `marketing-director-cli`), merges permission rules, and writes `.mcp.json` with `Authorization: Bearer ${STUDIO_TOKEN}`. The token is read from your environment. It is never written to a file.

Then, with `STUDIO_TOKEN` exported in the same terminal:

```sh
cd "$HOME/studio-host" && claude
```

Accept the **workspace trust dialog** and approve the `marketing-studio` project MCP server. Then run `/mcp` inside Claude Code. It should list `marketing-studio` as connected. (`claude mcp list` runs, but I only saw its warning for a missing token. The connected state is NOT RUN.)

### Codex

```sh
sh "$STUDIO_CORE/hosts/codex/install.sh" "$HOME/studio-host" studio-self "$STUDIO_WORKSPACE"
codex mcp get marketing-studio
```

Expected: `url: http://127.0.0.1:8765/mcp` and `bearer_token_env_var: STUDIO_TOKEN`. Then `cd "$HOME/studio-host" && codex`. A live Codex session with the Studio is NOT RUN, and Codex host acceptance is still pending. Treat Claude Code as the better-tested path.

If `codex` is not on your PATH, the installer prints the `codex mcp add` command to run later.

### Use the Studio from any chat (Claude Code)

The install above is per folder. To use the Studio from every Claude Code chat, in the terminal and the desktop app, install at user scope instead:

```sh
sh "$STUDIO_CORE/hosts/claude-code/install.sh" --user studio-self "$STUDIO_WORKSPACE"
```

This copies the skills into `~/.claude/skills`, merges the CLI permission rules into `~/.claude/settings.json`, and runs `claude mcp add --scope user` for `marketing-studio`. Other settings and MCP servers are kept. The token is still never written: Claude Code expands `${STUDIO_TOKEN}` from the environment when it connects, so export it before launching the app. I checked that expansion on Claude Code 2.1.325 against a stub server in a temp `HOME`. A live chat with the real Service is NOT RUN.

| Type this | What it does |
| --- | --- |
| `/studio-idea` or "capture this as a newsletter idea" | Writes a short brief from the current chat into your idea inbox through `idea_submit`. It never drafts, plans, approves or publishes. It leaves out secrets and private data unless you say to include them. |
| `/marketing-director`, then "open my latest idea" | The Director reads `ideas_list`, shows the latest idea and starts a session from it if you want. |
| `/marketing-director-cli` | The older CLI Director for sessions, evidence, revise and cancel. |
| `/mcp__marketing-studio__resume_session`, `…start_from_idea`, `…discuss_brainstorm`, `…propose_direction`, `…produce`, `…review`, `…proactive_scan` | The Studio's own prompts, listed after `/mcp__marketing-studio__` in the slash menu. `start_from_idea` needs a session slug and the idea text. |

If the Service is not running, `/studio-idea` says so and tells you how to start it. Captured ideas show as open ideas with `origin: owner_chat`. Their source references are your own pointers (files, URLs), not verified like scan ideas.

## 7. Connect your app's Linear connector

The Studio never gets a Linear token. It writes **change sets** (what to create or edit) and the Director passes them to your app's own Linear tools. Your app then returns **receipts** to the Studio.

- **Claude Code / Claude desktop:** open Settings, Connectors, and add Linear (or add the Linear MCP server), then sign in. Check that a Linear tool shows in `/mcp`.
- **Codex:** add a Linear MCP server in Codex settings and sign in.

Pick the Linear team where the series plan and draft docs should live. The plan and each draft are kept in Linear as docs you can read, comment on and edit. Real Linear runs are NOT RUN. The Linear side is tested only with a fake connector.

## 8. Your first session: "start a newsletter series about the Studio"

Open the app in `~/studio-host` (with `STUDIO_TOKEN` set) and type:

> Marketing Director, start a newsletter series about how Marketing Studio Core is built. Use the approved docs. Three issues to start. Do not draft anything yet.

What happens, step by step. The first three calls ran against the Service with the fixture provider. The rest are as the prompts and tools define them:

| Step | What the Director does | What you do |
| --- | --- | --- |
| 1. Start | `session_start` saves your raw idea. `context_search` finds approved docs. Docs are guidance, not proof | Answer one or two questions |
| 2. Shape | `work_shape_propose` saves a proposal: **one-off, series or campaign**, with count, audience promise and what stays out. It does not pick for you | Choose. Say "series". The Director then calls `program_shape_confirm`. This only creates unapproved planning state |
| 3. Plan | `program_plan_save` writes an ordered plan, each piece with its own angle and sources. It hands the host a change set for Linear | Read the plan in Linear |
| 4. Approve plan | `program_plan_submit_for_approval` makes a pending request for this exact plan | `passkey`: approve in the Inbox with Touch ID. `linear-review`: comment `/studio approve-plan <program id>` on the plan doc, then tell the Director |
| 5. Draft | `piece_draft_start` validates the piece and records its direction and sources; it starts no job. The Director then drafts with `run_start` (the writer and the fact and craft reviewers run there) and passes the run's QA receipts to `piece_revise`. The draft appears as a **Linear doc** | Read it in Linear |
| 6. Review | You comment or edit in the Linear doc. The Director reads the doc and comments through the connector and calls `piece_review_ingest` | Comment as usual |
| 7. Revise | `piece_revise` makes a new version only after fresh fact and craft QA. The doc updates | Re-read the new version |
| 8. Final | `piece_final_request` | `passkey`: Touch ID in the Inbox. `linear-review`: comment `/studio final <piece id>` yourself, then tell the Director. The Director never posts a marker for you |

Rules to remember:

- A pending request is not an approval. Approvals happen in the Inbox (or by your marker), never in chat.
- Failing fact or craft QA blocks a final.
- A final is a private editorial approval. **Nothing publishes.**
- Editing a doc after ingest reopens the piece. The Director must re-ingest first.

Both Directors coexist. The older CLI skill (`marketing-director-cli`) still works for sessions, evidence, revise and cancel. Use the MCP one (`marketing-director`) for series, programs and the Inbox.

## 9. Optional: a scheduled task for proactive ideas — NOT RUN

The Studio has no scheduler. Your app runs the schedule.

1. Claude desktop: create a scheduled task. Codex: create an automation. Run it daily or weekly.
2. Paste the prompt from [PROACTIVE.md](hosts/PROACTIVE.md). It calls `proactive_context` and `idea_submit` only.
3. Ideas land in the Inbox. Promoting one only creates a pending request. Touch ID is still needed to approve.

The task cannot start runs, approve, publish or spend money. You also set `watched_repos` (absolute paths of local Git repos to watch) in the tenant record, as [PROACTIVE.md](hosts/PROACTIVE.md) describes. The Service has no flag for it yet.

## 10. Troubleshooting

| What you see | Cause and fix |
| --- | --- |
| `Missing environment variables: STUDIO_TOKEN` (in `claude mcp list` or `/mcp`) | The token is not exported in the terminal that launched the app. Export it (step 4), then restart the app |
| `401` from the Service | Wrong or missing `Authorization: Bearer` token. Re-read the file under `~/.studio-service/tenants/*/token` |
| `Studio Service is already running for this tenant` | A Service is already up for that data root. Use it, or stop it with Ctrl-C in its terminal first |
| Port busy, or the app cannot connect | Start the Service on another `--port`, then re-run the installer with `STUDIO_PORT=<port>` in front, and restart the app |
| `Usage: studio-service ...` | `--data-root` and `--tenant` are required |
| `Invalid tenant id` | Use a longer id with letters, digits and dashes, such as `studio-self` |
| `Invalid tenant review policy` | `linear-review` needs `--linear-account <id>`. `passkey` must not have one |
| `First start requires a workspace template` | First start needs `--workspace` |
| `Service data root must be outside the workspace template` | Move `--data-root` out of the workspace folder |
| `Catalog ... is not available on this machine` | `CORE_CHECKOUT` in `studio-business.json` is wrong. Re-run the `sed` line in step 3 |
| Claude Code does not show the MCP server or skills | Open it from `~/studio-host`, accept the trust dialog, approve the project MCP server |
| Skill or MCP tools missing in Codex | Run `codex mcp get marketing-studio`. If it is missing, run the `codex mcp add` line from the installer output |
| Codex 401 or Claude login errors | Log in to the app with your subscription. Do not add an API key |
| Passkey code expired | Type `setup` in the Service terminal |
| Restricted source denied | Do not relabel it `approved`. Ask the Director for a scoped disclosure request |

Still stuck? Run `"$STUDIO_CORE/studio-runner/bin/studio" doctor` and read [host permissions](hosts/HOST-PERMISSIONS.md).

## 11. Stop and reset

- Stop the Service: Ctrl-C in its terminal.
- Keep your work: the workspace is in `~/studio-workspaces/`, and Service state is in `~/.studio-service`. Do not delete either unless you mean to.
- From your phone or Claude desktop? See [ANYWHERE.md](ANYWHERE.md).
- Try the fictional demo first? See [DEMO.md](DEMO.md).
- Run tests: `npm --prefix studio-runner test` and `python3 -m unittest discover -s tests -p 'test_*.py'`.

Next: [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Roadmap](ROADMAP.md) · [Authority and capability status](operations/AUTHORITY-AND-CAPABILITY-STATUS.md).
