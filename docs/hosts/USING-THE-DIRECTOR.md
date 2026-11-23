# Use the conversational Marketing Director (v0.7)

For the real-use setup guide, see [Getting Started](../GETTING-STARTED.md); the fictional walkthrough is [Demo](../DEMO.md). This document covers how to operate the Director after installation. The system is currently laptop-only, single-user and **draft-only**, not ready for sensitive data.

## Which hosts actually work?

| Host | Current status |
| --- | --- |
| Claude Code | Fresh-session CLI discovery, context search, saved-session continuity and local MCP calls demonstrated on synthetic data; Service cold start not run |
| Codex | Installer and offline permission rules tested; live discovery, Service cold start and MCP acceptance not verified |
| ChatGPT / Claude Chat | Not connected; require authenticated remote transport and tenant isolation |
| Local MCP | Loopback Service HTTP MCP is fixture-backed; stdio remains limited local tools; no remote authentication or publishing |

See [host acceptance evidence](../operations/HOST-ACCEPTANCE.md) and [permission limits](HOST-PERMISSIONS.md).

## Prepare a local project

1. Check out Core's `main` branch. Do not use the historical `release/infra-v07-rc` branch.
2. Prepare a **separate business workspace** with matching `studio-workspace.json` and `studio-business.json`, allowed source roots and approved catalog.
3. Install the Claude Code skill, passing the real paths:

```sh
sh hosts/claude-code/install.sh "<project>/.claude" <business-name> <workspace-dir>
```

4. Open Claude Code in that project and accept the workspace trust dialog only if you trust the project. Project allow rules are ignored before trust; neither ask/allow patterns nor model instructions prevent arbitrary shell bypass.

For Codex installation, use [Codex README](../../hosts/codex/README.md). A successful installer is not yet proof of a live Codex host integration.

## Conversational use

To explore without generating content:

> Marketing Director, evaluate this idea and check the business context we have saved. Recommend two possible directions, but don't start production.

To resume:

> Marketing Director, continue the earlier discussion. Show the confirmed decisions and the evidence still missing.

The host retrieves explicit session/context records; it **cannot automatically access other products' chat histories or credentials**. An authorized conversation capture is separate from a factual source.

## Approved asset workflow (deferred for private tenants)

1. Discuss a goal; retrieve only authorized business context.
2. Research sources with provenance and visibility; save a strategy note.
3. Review alternatives and an asset brief.
4. **Owner approves a direction in their own words**; direction approval is not permission to disclose private material.
5. The selected specialist (newsletter by default, `conversion-copywriting` only when selected) creates an asset through the shared Runner. The CLI can use the owner's local Claude subscription; the Service defaults to fixtures and can use a tenant-configured Claude Code or Codex subscription provider.
6. Fact QA, craft QA and the metadata gate produce a versioned private review package.
7. Owner revises or gives exact-version editorial approval; nothing is published.

The Runner's live providers are `claude-code-cli` and `codex-cli`. Each requires the corresponding local CLI's first-party subscription login and refuses its API-key environment, so neither path silently switches to paid API billing. **Do not attempt production with sensitive tenant evidence at v0.7.**

## Service provider per tenant

The Studio Service starts every new tenant with `"provider": "fixture"`, which keeps CI offline. At first start, a trusted operator can choose `--provider claude-code-cli` or `--provider codex-cli`; the choice is persisted in that tenant's `tenant.json`. To change an existing tenant, stop the Service and update that record (it can also hold a per-role `models` object; defaults are `sonnet` and `gpt-5.6-luna`). MCP requests and queued job files cannot choose or override it. Run `studio doctor` first: it reports CLI presence, detectable subscription login, and any API-key refusal. `codex-cli` is a subscription provider, pending one owner live acceptance run. The Codex adapter invokes `codex exec` in an empty read-only directory with shell and interactive integrations disabled.

## Private state and security

The business workspace stores `sessions/` (notes, evidence, approved directions), `captures/` (opt-in records), `sources/` and `.studio/` (SQLite, grants, audit, versions, QA and receipts). Core stores shared code, skills and agent contracts. Do not put business secrets into Core.

On the CLI path, owner quotes and grants are **unauthenticated assertions**. A shell-capable agent can manipulate local records, bypass host approval patterns, forge certain classifications (VULN-1), or resurrect revocation records (VULN-7b). The Service path uses a signed authority store and passkey inbox but still shares the OS user. Redaction and heading exclusion are best-effort. Read [Scoped Disclosure](../security/SCOPED-DISCLOSURE.md) and [current authority status](../operations/AUTHORITY-AND-CAPABILITY-STATUS.md).

For exact CLI syntax, evidence and grant handling, and recovery commands use [HOST-INTERFACE.md](HOST-INTERFACE.md). Do not change classification to bypass a refusal or interpret editorial approval as permission to publish.

[Getting Started](../GETTING-STARTED.md) · [Architecture](../ARCHITECTURE.md) · [Roadmap](../ROADMAP.md)
