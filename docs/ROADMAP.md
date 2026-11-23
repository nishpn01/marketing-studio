# Marketing Studio Core roadmap

This table is the current state of `main` (see `git log`). Evidence labels distinguish code from observed host use. The owner policy is laptop-only, subscription-only bring-your-own AI, host-scheduled proactive work, and no publishing.

| Status | Current capability or gap | Evidence / next action |
| --- | --- | --- |
| Implemented | Reusable Core, tenant-workspace separation, Director contracts and shared research/quality contracts | Current code and contracts; contracts remain guidance unless a row below names a runtime gate |
| Implemented | Legacy CLI Director with saved sessions, context retrieval, evidence, grants, revisions, exact-version draft review and the local `claude-code-cli` adapter | Synthetic Claude Code discovery/continuity and serial test suites; CLI approval/grant records are unauthenticated local assertions |
| Implemented | Studio Service on loopback with tenant state outside the copied workspace, signed authority store, passkey inbox, Director prompts and MCP tools, forked job workers and tenant-configured subscription providers | Service tests; fixture provider remains the default |
| Implemented | Newsletter and conversion-copywriting capability packs on the shared `text-asset` pipeline | Pack loader, role/prompt pinning, shared fact reviewer and fixture tests |
| Implemented | Newsletter and conversion eval fixtures/replay | `studio eval newsletter` and `studio eval conversion-copywriting`; deterministic synthetic evidence, not human quality certification |
| Implemented | Host-driven proactive digest, idea submission and owner-inbox promotion | `proactive_context`, `idea_submit`, inbox promotion; no Studio scheduler or model call |
| Fixture-tested | Service direction approval, disclosure requests, queued runs, exact-version editorial approval and proactive promotion | Passkey and MCP tests; fixture is the default and the Service still lacks CLI session/evidence/revise/cancel parity |
| Fixture-tested | Series and campaign programs with host-side Linear sync (fake adapter), per-tenant `review_policy` (`passkey` default or `linear-review`), exact-version piece finals gated on clean fact and craft QA, and a publish-gate contract that rejects `linear-review` finals | `program-approval` and `owner-inbox` tests; no real Linear connector run, publisher or destination-authorization UI |
| Fixture-tested | Source boundaries, signed authority integrity, passkey assertions, prompt/pack pinning, crash recovery and negative publish controls | Node/Python tests; the Service authority store still has same-OS-user replacement and rollback residuals |
| Host-demonstrated | Claude Code synthetic discovery, continuity and local stdio MCP calls | Host acceptance evidence; full Service cold start was not run in a real logged-in host |
| Host-demonstrated | Host installers generate/register Claude and Codex Director shims and MCP configuration without writing a literal token | Installer and offline checks; live Codex cold-start/MCP acceptance remains open |
| Not done | Connector-signed Linear receipt for `linear-review` markers | Today the marker is host-asserted and unverifiable by the Service (`authenticated:false`, never publish-eligible); a signed receipt would make a fabricated approval need a forged receipt |
| Built, live run NOT RUN | Separate-user laptop installation for the Service (the tracked authority milestone): `studio-install` script, launchd daemon, owner-side `verify`, uninstall, [doc](operations/SEPARATE-USER-INSTALL.md) | Unit-tested with mocked OS; needs the owner's sudo run, the official root-owned Node, a one-time model login as the service user (unverified on macOS), then `verify`; admin/root residual remains. Hard gate before any internet exposure |
| Not done | Specialist intake workflow: turn a researched strategy into a new pack | Next: define the owner-reviewed intake and add the first new specialist, owner choice such as carousels |
| Not done | Proactive v1 beyond bounded idea intake | Next: owner host task, inbox digest and policy acceptance; no pre-drafts or autonomous publishing |
| Not done | A real-provider Service run on the owner's subscription | Next: validate tenant-configured Claude Code or Codex execution with synthetic data; keep fixture tests |
| Not done | Real host cold-start acceptance for the Service path | Next: Claude Code and Codex login-based tests with synthetic data |
| Not done | End-to-end Service run with real business data and semantic marketing-quality or independent human-review evidence | Requires owner acceptance and separate data/quality evidence |
| Not done | Full Service parity with CLI sessions, evidence, captures, revise, cancel and real-provider production | Keep both Directors until parity |
| Deferred | API ModelPort adapter for customers who bring their own API key | Not rejected. Owner/default runs stay subscription-only and refuse API keys |
| Deferred | Remote gateway (tunnel + OAuth + read/capture-only tools) for claude.ai/phone, and ChatGPT/Claude Chat integration | Not rejected; after the separate-user install. Prerequisite: the localhost wiring (`rpId` `localhost`, inbox `Host`, `/mcp` `Host`/`Origin`) needs an allowlisted-host design and a new WebAuthn RP ID before any tunnel. The owner inbox and Touch ID approvals are never exposed remotely; never tunnel the stdio MCP |
| Deferred | Publishing, scheduling, account changes and analytics | Not rejected; nothing publishes |
| Deferred | Sensitive or multi-user use, automated engineering worker/merge, and proactive pre-drafts | Revisit only after authority, host and quality gates are accepted |

## Next sequence

1. Run the the tracked authority milestone separate-user install on the owner's laptop (sudo, owner action) and confirm `studio-install verify`.
2. Add the owner-reviewed specialist intake workflow: turn a researched strategy into a pack, then ship the first new specialist chosen by the owner, such as carousels.
3. Define proactive v1 as host-scheduled, bounded idea intake and inbox review.
4. Validate tenant-configured Service execution through the owner's subscription and run a real host cold-start acceptance with synthetic data.

Historical release notes and audit reports remain evidence of what was true at their dates. They are not current capability statements; use this roadmap, [Architecture](ARCHITECTURE.md), and [authority status](operations/AUTHORITY-AND-CAPABILITY-STATUS.md).
