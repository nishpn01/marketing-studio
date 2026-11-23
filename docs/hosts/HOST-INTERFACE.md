# Host interface: conversational Marketing Director

**What it is.** A host is the chat product the owner talks to: Claude Code or Codex today. The host model plays the **Marketing Director** in conversation. Core currently has two paths:

- The **legacy CLI path** (`studio-runner/bin/studio`) owns the complete local session workflow and local subscription model adapters.
- The **Studio Service path** (`studio-runner/bin/studio-service`) owns loopback MCP, signed authority, the passkey inbox and tenant-configured async runs (fixture by default).

The CLI holds everything that must be durable for its path:
- the business profile;
- evidence with provenance;
- strategy notes;
- the owner-approved direction;
- the production run, review package, revisions and approval.

Both paths use the same contracts and pack engine, but they do not yet have parity. The CLI persists session files; the Service persists signed authority and pending jobs. A host can pick up only the records that its path supports.

## Status by host (2026-11-12)

| Host | Conversation | Local CLI | Research tools | Production run | Status |
|---|---|---|---|---|---|
| **Claude Code** | CLI and Service shim | yes | its own web, `gh` and Drive connector tools | CLI live route via the owner's Claude login; Service fixture default or tenant-configured Claude login | Synthetic CLI discovery/continuity and local MCP calls demonstrated; Service cold start not run |
| **Codex (CLI or desktop)** | CLI and Service shim install | yes | Codex's own tools | `codex-cli` is a subscription provider, pending one owner live acceptance run; Service fixture remains the default | Installer and offline rules tested; live Codex skill/MCP acceptance not shown |
| **ChatGPT** | yes | **no local shell** | its own connectors (GitHub, Drive) | not possible from ChatGPT alone | **Not integrated.** Needs a host with a shell, or an authenticated remote tool transport that does not exist (see `LOCAL-TOOL-INTERFACE.md`) |
| **Claude Chat (claude.ai)** | yes | **no local shell** | its own connectors | not possible | **Not integrated**, same requirement as ChatGPT |
| **Any local MCP client** | n/a | yes | n/a | Service fixture route or limited stdio tools | Loopback Service HTTP MCP is separate from the unauthenticated local stdio MCP; neither is hosted |

**Credentials never transfer.** Evidence a host retrieved through its own connectors is stored as text plus provenance (`retrieved_by`, URI, revision, time, visibility). No host reuses another host's credentials.

## Lifecycle

```
Legacy CLI:
session-start → discussing
  ├─ context-search (relevant passages; read-only)
  ├─ evidence-add --catalog | --kind web|github|gdrive|other   (originals plus provenance)
  ├─ session-note --kind strategy|campaign_plan|creative_brief|research_summary|decision
  └─ direction-approve (owner's own words required) → direction_approved
session-run → existing Runner (Director brief → writer → metadata gate → fact QA → craft QA → bounded revision)
  → in_review (run WAITING_FOR_OWNER) | needs_evidence (Runner Director refused) | run_failed
revise --run-id   → new immutable version, QA re-run
approve --run-id --digest [--decisions]   → CLI editorial approval of that exact version (unauthenticated; never publishes)
cancel --run-id --reason
```

Service/MCP (including `session_start` and approved catalog evidence via `evidence_add_catalog`):

`request_direction_approval` or `request_disclosure_grant` → signed pending inbox request → passkey decision → `run_start` → forked tenant-configured worker (fixture by default) → `run_status` → exact-version private review. Proactive host tasks use `proactive_context` and `idea_submit`; they do not start runs or approve anything.

## Commands (all JSON out; all take `--workspace <business workspace>`)

| Command | Purpose | Key rules |
|---|---|---|
| `context-sync` | Copy the owner's guidance files (style guide, campaign decisions) into `context/`, with a provenance header | Targets must be inside `context/`; sources must resolve to exactly one approved catalog entry inside `allowed_roots`. Its exclusions and redactions are applied before copying. |
| `context-search --query Q [--limit N]` | Section-level retrieval over approved catalog entries, Director-scoped `context/` files, and approved captures | Privacy rules applied first; `context/` results labelled "guidance (not evidence)". Restricted catalog entries and captures are omitted. Context files must be declared for the Director in `studio-context.json`. |
| `session-start --idea TEXT [--slug S]` | Open a durable discussion | Slug: lowercase letters, digits, hyphens |
| `evidence-add --session S --catalog ID [--section H]` | Add business evidence from the catalog | Exclusions and redactions applied and recorded; visibility carried; git commit and original sha256 pinned |
| `evidence-add --session S --kind K --uri U --file F --retrieved-by host:tool [--revision R] [--visibility V]` | Add evidence the host retrieved | GitHub/Drive need a revision; Drive/GitHub/other default to restricted; original text of 50 characters or more, not a summary |
| `session-note --session S --kind K --file F` | Persist strategy, a campaign plan, a creative brief, a research summary or a decision | Stored under `sessions/S/notes/` |
| `direction-approve --session S --direction F` | Record the agreed direction | Needs evidence and `approval.type` owner or test-authorization, plus the approver's own words. An explicitly chosen `specialist` may select a registered route; omission keeps the newsletter default. |
| `session-run --session S [--host H]` | Generate the Runner request from the profile and session, then run it | Refuses without an approved direction, or if any evidence changed since approval |
| `session-status [--session S]` | Sessions, state, run status, version, digest, blockers, package path | Read-only |
| `capture-import --file F --host H --format FMT --title T --authorization TEXT [--visibility] [--conversation-id] [--from N --to N]` | Import an owner-supplied conversation (ChatGPT export, Claude export, Claude Code `.jsonl`, labelled text, or `studio.transcript/0.1` JSON) | Requires `capture.enabled` and an allowed host in `studio-business.json`, plus the owner's words. Emails, secrets, phone numbers and profile strings are redacted in message text, the title and annotate paraphrases (best-effort patterns). Duplicates are refused; a changed export of the same conversation supersedes the old one. Restricted by default |
| `capture-annotate --capture ID --record F --annotated-by host:tool` | Record decisions, reasons, alternatives, rejections, ideas, questions, uncertainties, links and artifact refs | Each quote must be verbatim from its message, with the speaker checked. Decisions, ideas and owner questions must come from the owner (or a decision is confirmed by a later owner message). Nothing is a permitted public claim |
| `capture-list`, `capture-show --capture ID --ref ci-N\|mN` | List captures or read an approved capture, item by item | Restricted captures cannot be shown. `context-search` returns approved capture items and messages as bounded passages labelled "not evidence" |
| `capture-disclosure-grant --file F`, `capture-disclosure-read --grant ID --session S --host H`, `capture-disclosure-revoke --grant ID --owner-quote TEXT` | Explicitly record, use, or revoke a narrow internal-reading grant for one restricted owner-message excerpt | Local operator and host are **not authenticated**. Grant binds workspace, session, asserted host, Director role, `internal_read` purpose, capture digest, message and exact excerpt; it never authorizes factual use, drafting, or publication. Other captured messages are not returned. |
| `source-disclosure-grant --file F`, `source-disclosure-list [--session S]`, `source-disclosure-revoke --grant ID --owner-quote TEXT` | Grant, list (metadata only), or revoke scoped disclosure of exact excerpts of a restricted source to named model roles for `drafting` | Local operator and host are **not authenticated**. Grant binds workspace, session, asserted host, roles, purpose, exact source path and sha256, and literal excerpts; the model sees only those excerpts. Revalidated before every model call, resume, revise, approve and handoff; `session-run`/`session-rerun` need `--host`. Never authorizes publication. See `docs/security/SCOPED-DISCLOSURE.md`. |
| `improvement-propose --session S --proposal F --reported-by host:tool` | Record a flaw found during content work, linked to the session and run | Needs the owner's words. Scope is inferred from `affected[]` and must match. Every reference must resolve. Shared and code scopes need `tests_required` |
| `improvement-handoff --id I --target claude-code\|codex` | Write an engineering brief (repo, base commit, evidence, tests, rules: draft PR only, no merge) | Engineering scopes only. **Direct invocation of a worker isn't implemented** |
| `improvement-record --id I --change REF [--tests "cmd => result"] [--version vNNN]` | Record the tested change, or the newer draft version for an asset fix | Test evidence is required for code, shared and source changes |
| `improvement-decide --id I --decision approve\|reject --owner-quote TEXT`, `improvement-close --id I`, `improvement-list` | The owner's decision, then how to continue the newsletter | Approval merges nothing. Close reports whether to `revise` or `session-rerun` |
| `session-rerun --session S --reason TEXT [--host H]` | Continue the same newsletter in a fresh run after a fix changed pins | Same approved direction and evidence. Earlier runs are kept. Changed evidence blocks it |
| `revise`, `approve`, `cancel`, `inspect`, `handoff-prompt`, `handoff-score` | Existing E4/E5 controls | Unchanged |

Legacy evidence whose provenance lists literal redaction text or excluded headings is refused for model-backed runs and handoffs. Preserve the old evidence and run history; add a newly sanitized copy in a new or appropriately reset session rather than changing an existing pinned file.

The capture disclosure input file must contain `workspace_id`, `session`, `host`, `role` (`director`), `purpose` (`internal_read`), `capture_id`, 1-based `message`, an exact `excerpt`, `exclusions` (array), and the owner's `owner_authorization` text; optional `expires_at` must be a future timestamp. Only an owner-attributed message in a restricted capture qualifies. The grant and audit history live in `.studio/capture-disclosures/`. The source is rechecked on every read, and revocation blocks future reads. Grants are bound to the local workspace's resolved path and must be reissued after a move or copy. Already disclosed text and past records cannot be recalled. The local filesystem and asserted host identity are not a security boundary against a process with the same user's access; remote use requires authenticated authorization and OS-level isolation.

## Files a host reads and writes

- **`studio-business.json`** (owner-maintained, trusted): workspace ID, `vars`, `allowed_roots`, `defaults` (audience, provider, models, budget), and the `catalog`. Each catalog entry has an ID, path, visibility, description, and optional `exclude_headings` and `redact`. Optional `context_sync`. Template: `templates/workspace/studio-business.example.json`.
- **`studio-context.json`** + `context/`: the role-scoped guidance overlay (E6).
- **`sessions/<slug>/session.json`, `direction.json`, `notes/`, `request.json`**: conversation state. `request.json` is generated; nobody writes it by hand.
- **`sources/<slug>/*.md`**: evidence, each with a JSON provenance header.
- **`.studio/artifacts/<run>/review-package.md`, `run-snapshot.json`**: what the owner reviews, and the portable handoff.

## What a new host adapter must do

1. Ship a host-native instruction file. Today that means two: the generated Service shim (`hosts/generate.ts` writes `hosts/claude-code/marketing-director/SKILL.md`) and the CLI procedure `hosts/claude-code/marketing-director-cli/SKILL.md`. Keep both until the Service covers host evidence, captures, revise, cancel and a real subscription provider. Both carry the same rules: no invented approvals; context is guidance, not evidence; disclosure rules apply.
2. Run the selected path. A host without a shell needs the remote gateway, which is deferred.
3. Record retrieved evidence with `--retrieved-by <host>:<tool>`.
4. Add a `ModelPort` adapter only if production should run on that host's models. That is separate from the conversation.
