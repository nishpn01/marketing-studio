# AI agent versus workflow — architecture and implementation status

**Historical status note:** this file predates the current `main` Service, pack/eval and proactive implementation. Use [Architecture](ARCHITECTURE.md), [Roadmap](ROADMAP.md) and [Build Log](BUILD-LOG.md) for current delivery status.

## Final product: an AI agent system

The goal is an **end-to-end, model-agnostic marketing Studio** with a Director that can research opportunities and plan campaigns based on business context, and independently upgradable specialist agents for newsletters, SEO, video and future formats. It is not intended to remain a static content template generator.

A **workflow** is a repeatable professional procedure (reader research, draft, fact check, unslop, approval). The **agent** reads the goal, current sources and task state; chooses whether there is enough evidence, what issue/format to pursue, which tools/skills to use, when to request clarification, and what the next best action is. The runner executes these decisions safely.

## Architecture intended

Owner request / host task
→ CLI Director or loopback MCP Service
→ durable Runner / forked fixture worker (id, permissions, budgets, retries, resume)
→ Newsletter or Conversion pack (SEO and Video remain contracts)
→ skill registry (selected copywriting research, newsletter editorial craft, original /unslop when available, real source mining)
→ independent fact + editorial QA
→ owner review and exact-version approval
→ authorized distribution/publish adapter (later)
→ recorded outcomes and controlled skill improvement.

Business files and private customer context live in an independently permissioned workspace (e.g. Google Drive); the reusable core contains only methods, tests, contracts and generic fixtures.

## Current state, not aspirational labels

| Capability | Current reality |
|---|---|
| Director decision contract | Markdown spec exists |
| Newsletter specialist professional procedure | Markdown skill/workflow exists; manually executed by AI tools |
| GitHub evidence access | Available to authorized tools in conversational sessions; NOT automatically built into a daemon |
| Copywriting + newsletter craft research | Studied and distilled; not validated by production outcomes |
| /unslop | Public reference inspected; portable independent-review adapter added; installed Claude version not verified |
| Source-provenance checker | Basic structural checker and synthetic tests on draft branch; it does not independently check facts |
| Actual newsletter production | Human-directed AI session has made private candidates; owner has rejected some and reviewed one as improved |
| Model-agnostic runtime / CLI | CLI Runner and `ModelPort` exist; only `claude-code-cli` is live |
| Durable execution, resume across sessions | Implemented locally and fixture-tested; Service workers are forked |
| Agent tool registry and permission enforcement | Implemented allowlists; Service authority writes require the passkey inbox |
| Linear triggers and schedule | Linear sync is not implemented; proactive scans are host-scheduled, not Studio-scheduled |
| Google Drive business workspace | Proposed structure; NOT yet provisioned by this core |
| Publish/metrics adapters | **Not implemented**; no automation or posting |
| Continuous self-improvement loop | Governance/specs exist; NOT an autonomous learning implementation |

An AI assistant following these Markdown workflows can do a useful interactive task. The current repository also contains an independently running local Service, but its production provider is fixture-only and its same-OS-user boundary is residual.

## Proposed Studio-wide requirement, November 10

The user wants to brainstorm freely, sometimes with several competing or future ideas in one message, have the Director conduct research and ask **selective** clarifying questions, preserve a linked idea portfolio and strategically allocate work across newsletter, SEO, video and other specialties. This requires a first-class [Director idea-to-campaign contract](../core/IDEA-TO-CAMPAIGN.md) and the archived [Architecture v0.4 proposal](archive/ARCHITECTURE-v0.4-PROPOSAL.md). It is not just another revision to the newsletter writer; the runtime and persisted idea state are still to be built.

## Minimum implementable agent milestone — after quality gate

The original manual-triggered CLI milestone is implemented. The next engineering work is separate-user Service installation, specialist intake, real-model Service execution on the owner's subscription and real host cold-start acceptance. Background proactive work remains host-scheduled and bounded.

```
marketing-studio run newsletter --workspace <authorized-workspace> --objective "Plan next Zero to MVP issue"
```

Expected behavior:
1. Authorized workspace manifest resolves source locations and credentials from runtime, never GitHub source.
2. Director chooses an evidence-backed idea, or returns "research missing / skip".
3. Newsletter agent dynamically chooses format and source references, drafts to the private workspace.
4. An independent reviewer applies source checks and /unslop; source edits trigger re-audit.
5. Save a durable run record (input, source IDs, decisions, skill versions, artifact links, pending approval) with bounded retries and cost.
6. Return owner review links, **not** published output.
7. Provide a resume command or equivalent to incorporate feedback. Approval for a *draft* is not permission to post.

The runner should allow model adapters/providers to be swapped without editing editorial method files; it must never self-enable an account connector or publish without explicit permission. GitHub/Drive/Linear are adapters. Plan the runtime with the same clean tenant isolation needed for future friend installation and SaaS.

**Completion gate:** A successful single run that reads real repo evidence, proposes/creates a useful issue, invokes a QA skill, persists outputs and survives restart without duplicating work. That is the first credible "working end-to-end agent (human-in-loop)" milestone. Autonomous publication and monitoring are later optional extensions.
