# Marketing Studio Core build log

**Date:** 2026-11-12  
**Basis:** `main` as of this entry (see `git log`), with the final audit at `7f609da` as the starting audit and PR #34 used only for owner-decision notes. This is a factual build record, not a claim of production readiness.

## Starting state

The final audit found that `main` already ran the local Studio Service fixture route end to end: MCP initialization, pending direction, passkey approval, async fixture run, signed exact-version editorial approval and host-triggered proactive idea promotion. The legacy CLI still supported the broader session and real local Claude subscription route. The audit also found stale documentation that called the merged code unmerged PR #23, directed fresh users to the obsolete `release/infra-v07-rc` branch, described proactive and Service authority as future work, and omitted the distinction between the CLI and Service trust boundaries.

PR #35 added conversion eval fixtures and PR #36 fixed the audit's parallel-test race and normal Git worktree rejection after that audit was written. The documentation below reflects those merged changes.

## Decisions recorded in this session

- `main` and the code on it are authoritative. Historical PRs, checkpoints and audit reports keep their dates and are not rewritten into current-state claims.
- The owner runs Studio on a laptop. The owner uses subscription-only Claude/Codex apps and brings their own AI. No API key is needed or accepted for the current owner workflow.
- The legacy CLI Director and generated MCP Director stay installed together until Service parity. The CLI owns sessions, evidence, captures, revisions, cancellation and the local Claude adapter. The Service owns signed authority, the passkey inbox, loopback MCP and async execution (fixtures by default, or a tenant-configured subscription provider).
- Proactive work is triggered by scheduled tasks in the owner's host app. Studio has no scheduler, no proactive model call and no publisher.
- A customer-key API ModelPort, the remote gateway, ChatGPT/Claude Chat, publishing, scheduling and analytics are deferred, not rejected; owner/default runs are subscription-only (see the [owner policy](operations/AUTHORITY-AND-CAPABILITY-STATUS.md#owner-policy-2026-11-14)).
- The docs were rebuilt around implemented, fixture-tested, host-demonstrated, not done and deferred states. A specialist intake workflow and a first new specialist remain next work, with the owner choosing the specialist.

## Merged implementation record

### PR #25 — v0.7 integration base

Integrated the Runner, host rules, CI, core contracts, security entrypoints, public README, workspace fixtures and the documentation/archive structure into the release candidate base. It supplied the synthetic quick-start fixture classification that makes the documented command pass.

Independent review confirmed the integration and link scan, then caught two factual nits: the Runner README still said CI had no TypeScript check, and the PR-stack table described PR #11 as removing a route it predated. Both were corrected before the integration was accepted.

### PR #26 — local Studio Service skeleton

Added the loopback HTTP MCP Service, tenant records outside the copied workspace, bearer token and Origin/Host checks, queued jobs, worker recovery and Service tests.

Independent review caught an indirect authority path in `run_start`, synchronous work blocking the HTTP loop, a kill test that killed after completion rather than during a model call, missing Service locking and atomic writes, unsafe workspace copying, unbounded queue/pending growth and fixture-only execution hidden by the initial description. The follow-up fixes built Service requests from signed state, forked workers, added locks and atomic handling, narrowed tenant copying, bounded worker concurrency (one forked worker at a time; no LOCKED fork loop) and labelled the provider fixture-only. The remaining same-user authority problem was kept as a documented separate-user follow-up.

### PR #27 — capability packs

Moved newsletter and conversion copywriting into `packs/<id>/pack.json` manifests and prompts, made the generic `text-asset` pipeline pack-driven, kept shared fact review loader-owned and proved a fixture pack can run without a Runner source change.

Independent review caught undisclosed craft-prompt changes and duplicate rubrics, stricter claim-item validation, stranded pre-pack resume/revise pins, replaceable fact review, intermediate symlink escape and weak fixture assertions. Pack reconciliation restored prompt behavior, kept compatibility, enforced shared fact review, tightened path checks and refreshed the pack-aware tests and Service request pinning before merge.

### PR #28 — deterministic pack eval harness

Added `studio eval`, recorded newsletter fixtures, prompt hashes, baseline comparison and stale-recording detection.

Independent review sabotaged prompts and showed that role-only recordings still passed 8/8. The fix keyed recordings to rendered system prompts and reported stale recordings before regressions. A second verification found the PR's own git-ref baseline assertion failed at the committed head; that one-line test defect was fixed before merge. The eval path remains deterministic and does not call a production model.

### PR #29 — signed Service authority

Moved Service source classifications, direction decisions, disclosure grants and revocations into a signed per-tenant SQLite authority store outside the copied workspace. Workers receive the authority key through the Service process, and MCP exposes pending requests instead of authority writes.

Independent security review found fail-open handling for deleted or tampered rows, a pending-request time-of-check/time-of-use swap, replayable request completion and ordering ambiguity. The integrity checks, positive controls, signed request snapshots and one-time decision handling were added and re-verified. The review retained the explicit same-OS-user key/store replacement and rollback residual for separate-user installation.

### PR #30 — passkey owner inbox

Added the localhost Studio Inbox, WebAuthn passkey registration/assertion, CSRF and Origin/Host checks, signed pending snapshots, direction/disclosure decisions, revision actions and exact-version editorial approval.

Independent security review found that an approval for `v001` could still be reported for attacker-controlled `v002`, plus setup-code attempt exhaustion and incomplete COSE/public-key binding. The current-version/draft-byte digest check, per-client setup attempt handling, terminal code refresh and attested-key derivation were added and verified. Inbox approval remains private state and never publishes.

### PR #31 — generated Director host shims and MCP prompts

Added canonical MCP Director prompts and generated Claude/Codex shims, registered the Service MCP server using `STUDIO_TOKEN`, restored the separate `marketing-director-cli` skill, and added host smoke tests.

Independent review found a prompt/tool schema mismatch after merging with the inbox, a Service prompt gate that read CLI session state instead of signed Service state, and loss of CLI capabilities before Service parity. It also found missing Codex MCP registration and a weak session assertion in the smoke test. The prompt schema and gate were corrected, the CLI skill was restored, both installers were aligned, Codex registration was added and the smoke test now starts and reads a real session.

### PR #32 — learning chapters

Added six learner-facing chapters covering agents, durable runs, trust and approvals, MCP and hosts, packs and specialists, and evals/improvement.

Independent accuracy review found stale role-registry references, missing distinctions between fixture evidence and quality proof, and several explanations that overstated current enforcement. The chapter corrections and mutation-sensitivity example were applied. Chapter 01 now points to pack manifests, not the deleted `studio-runner/roles/roles.json`.

### PR #33 — proactive v0

Added bounded proactive context, verified idea submission, the `proactive_scan` MCP prompt, inbox idea review/promotion, cursor and digest handling, and tests for prompt injection, provenance and idempotency.

Independent review found unsafe promotion ordering, unbound source references, digest/cursor edge cases and Git repository validation gaps. The fixes made promotion transactional and inbox-only, bound provenance to the digest, hardened cursor/version behavior, added idempotency and retained path/symlink checks. The final verification found no remaining required fix. Proactive is host-triggered; the Service does not schedule or run a model.

### PR #34 — closed draft documentation attempt

PR #34 was not merged. Its owner-decision notes were useful: laptop-only, no paid API, host-scheduled proactive work, the CLI retained until parity, and API/hosting deferred. Its architecture and roadmap were written against the pre-merge `fm/msc-proactive` view and incorrectly treated packs/evals as absent. This reconciliation keeps the owner decisions and rebuilds the docs against `main`.

### PR #35 — conversion-copywriting eval fixtures

Added conversion-copywriting eval fixtures for clean output, malformed and unsupported claims, scope, privacy, story, quote and craft cases, including a clean `WAITING_FOR_OWNER` case. The pack now has replayable coverage rather than only executable production code.

Independent verification found that the initial set lacked a clean conversion pass and that the quote fixture name overstated what it tested. The clean fixture was added and the malformed-quote case was renamed before merge. The replay is still synthetic regression evidence, not a semantic quality certification.

### PR #36 — parallel-safe tests and normal Git worktrees

Fixed the shared temporary fixture used by `OPUS-G1` by giving each test a private temporary directory. Updated watched-repository validation to accept ordinary Git worktrees through Git's own resolved paths while retaining symlink, external-gitdir, traversal and data-root protections. Added a worktree acceptance test.

The final audit had reproduced both defects: concurrent suites failed because processes overwrote `.tmp-skill.md`, and the Service rejected the audit checkout because `.git` was a normal worktree pointer. PR #36 addressed both. Full repeated parallel validation belongs in the release check.

## What was not done

- No sensitive or customer data, publishing, account change, paid API, hosted deployment or remote ChatGPT/Claude Chat connection was used.
- The Service still uses the fixture provider. Real-model Service execution through the owner's subscription is next work.
- Separate-user Service installation (the tracked authority milestone) is pending; same-OS-user key/store replacement remains a real authority risk.
- Codex live cold-start and Service MCP acceptance remain unverified.
- No human semantic marketing-quality study or real business end-to-end Service run exists.
- Service parity with CLI sessions, evidence, captures, revise, cancel and real-provider production is not complete.
- A Studio scheduler, proactive pre-drafts, publisher, scheduling and analytics remain deferred.

## Open risks

1. The legacy CLI still has unauthenticated approval and grant paths and remains safe only for trusted local synthetic or nonsensitive use.
2. The Service passkey boundary is local but not a separate-OS-user boundary. the tracked authority milestone is the next authority milestone.
3. Fixture evals can catch recorded regressions but cannot prove model obedience, human editorial quality or business outcomes.
4. A host app can schedule a scan, but there is no notification, real-model execution or autonomous publishing path.
5. Historical reports contain earlier branch names and counts. Use current [Architecture](ARCHITECTURE.md), [Roadmap](ROADMAP.md), and [authority status](operations/AUTHORITY-AND-CAPABILITY-STATUS.md) when quoting current state.

Next step toward proactive: install the Service under a separate local OS user, then define proactive v1 as a host-scheduled, bounded specialist-intake workflow.
