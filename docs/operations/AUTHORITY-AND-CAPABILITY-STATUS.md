# Authority and capability status

This is the current status of `main` (see `git log`). It describes repository behavior, not permission to use private business data or to publish.

## Owner policy (2026-11-14)

This is the single statement of the owner policy; other docs link here instead of restating it.

- Laptop only. Loopback-only today. Remote access (claude.ai/phone) is planned only through the approved remote-gateway design (tunnel + OAuth + read/capture-only tools, after the separate-user install); the owner inbox and Touch ID approvals are never exposed remotely. The stdio MCP has no listener and is never tunneled. The tunnel is a free one: no paid hosting.
- Owner/default runs are subscription-only and refuse API keys; the owner never pays for API usage. An API adapter for customers who bring their own API key is deferred (roadmap), not rejected.
- Proactive scans are triggered by scheduled tasks in the owner's host app, not by a Studio scheduler.
- The legacy CLI Director and generated MCP Director coexist until Service parity.
- Nothing publishes. Editorial approval is exact-version private state, not publication authorization.
- Video is paused. Only text pieces run; the video specialist is a placeholder.
- The remote gateway, ChatGPT/Claude Chat, publishing, scheduling and analytics are deferred, not rejected. Subscription-backed Claude Code and Codex ModelPorts are available only through tenant configuration.

## Current capability matrix

| Capability | Current enforcement/evidence | Limit |
| --- | --- | --- |
| Legacy CLI sessions and model-backed route | `studio` CLI, `claude-code-cli`, saved sessions, source/grant gates, revisions and QA | Approval/grant/owner identity is unauthenticated local text; VULN-1 and VULN-7b remain accepted CLI limits |
| Service MCP | Loopback HTTP MCP, Director prompts and tools, signed authority store, forked workers and tenant-configured provider (fixture default) | Real-provider host acceptance is not verified; no CLI session/evidence/revise/cancel parity |
| Owner inbox | WebAuthn passkey, CSRF/origin/host checks, signed pending snapshots, exact-version digest checks | Same-OS-user replacement or rollback of Service key/store remains possible until the [separate-user install](SEPARATE-USER-INSTALL.md) (the tracked authority milestone) is run; once installed, only admin/root can do it |
| Series review policy | Tenant `review_policy`: `passkey` (default; inbox assertion bound to piece, version, QA digest and Linear revision) or `linear-review` (named-account marker on the current revision, `authenticated:false`). Final requires re-verified clean fact and craft QA. A publish gate contract exists and rejects linear-review finals | Linear connector is host-side and only fake-tested; a Linear login cannot prove the owner was present; the Service cannot see live Linear, so a final can lag an un-ingested Linear edit until the host ingests it (which reopens the piece), and the `linear-review` marker is host-asserted: the Service cannot verify the comment exists in Linear (recorded `authenticated:false`, never publish-eligible; a connector-signed Linear receipt is the planned hardening); no publisher, scheduler or destination-authorization UI exists |
| Source disclosure | Legacy Runner enforces role/purpose/excerpt/source-version checks; Service stores signed disclosure requests | Legacy filesystem is not an authority boundary; disclosed text cannot be recalled |
| Packs and evals | Newsletter and conversion packs, shared fact review, deterministic eval fixtures and replay | Evals are synthetic regression evidence, not semantic or human quality certification |
| Proactive | Host-triggered bounded Git/run digest, verified idea submission and inbox promotion | No Studio scheduler, model call, pre-draft or publisher |
| Hosts | Claude Code synthetic discovery/continuity and local stdio MCP demonstrated; installers and Codex offline rules tested | Live Service cold start and Codex host/MCP acceptance not verified |

## Rules versus enforcement

| Rule | Status |
| --- | --- |
| Never publish, spend, alter accounts or infer publication from editorial approval | Enforced for current product surface; no publisher or account adapter exists |
| Publishing always needs a passkey final, whatever the review policy | Contract and tests only (`publishGate`); `linear-review` finality can never satisfy it |
| Do not invent owner decisions | Service enforces passkey inbox decisions; legacy CLI records unauthenticated assertions and relies on host guidance |
| Restricted source needs a scoped grant | Enforced by Runner and Service paths, with legacy same-user filesystem residuals |
| No authority writes through MCP | Enforced; MCP creates pending requests only |
| Owner runs never use an API key | Subscription adapters refuse their API-key environments; external subscription billing cannot be independently audited |
| Laptop-only | Enforced by loopback bind, not by an OS sandbox; a separate-user daemon install is available but not yet run |
| Proactive is host-scheduled | Enforced by the absence of a Studio scheduler and by the proactive MCP prompt/tool surface |
| Business data stays out of Core | Repository policy and synthetic fixtures; no technical mechanism prevents a user from committing private data |

## Not done

Live run of the separate-user installation (script and doc exist: [SEPARATE-USER-INSTALL](SEPARATE-USER-INSTALL.md)), a real-provider Service run on the owner's subscription, real host cold-start acceptance, end-to-end Service use with business data, semantic marketing-quality evidence, and full Service parity with the CLI.

## Historical reports

The dated release decisions, checkpoints and host reports record earlier states. Use [Architecture](../ARCHITECTURE.md), [Roadmap](../ROADMAP.md), and [Build Log](../BUILD-LOG.md) for current state.
