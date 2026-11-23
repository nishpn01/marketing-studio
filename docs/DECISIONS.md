# Architecture decision register — current Core policy

Entries marked Recorded describe the current repository and owner policy. Entries marked Proposed remain design guidance; a checked-in document is not proof of owner approval for a protected action.

| ID | Status | Decision | Rationale |
|---|---|---|---|
| CORE-001 | Recorded | Keep reusable core separate from business-specific tenant workspace. | Prevents tenant leakage; enforced as repository policy and layout. |
| CORE-002 | Recorded | One Studio Director with independently upgradable specialist contracts. | Current CLI and generated MCP Director both delegate to versioned packs. |
| CORE-003 | Recorded | Newsletter and conversion copywriting are current packs; SEO, social and video remain future contracts. | Current code contains the two packs and their evals. |
| CORE-004 | Proposed | Linear is an optional interaction and project-management adapter, not the sole memory/storage engine. | Works with existing workflow and can be replaced by a SaaS UI later. |
| CORE-005 | Proposed | GitHub holds versioned core rules and evaluators; business documents may live in private Drive/tenant-specific repos. | Global methods and company truth have different change cycles/privacy rules. |
| CORE-006 | Proposed | Goals and outcomes constrain agents, rather than rigid step-by-step content templates. | Allows expert research and creative judgment while keeping honesty, scope and budgets bounded. |
| CORE-007 | Proposed | Two loops: asset improvement and slower post-publication experiments. | Newsletter fit and marketing impact are separate measurable problems. |
| CORE-008 | Proposed | Feedback generates a proposed, scoped change + tests; no silent self-modification. | Prevents model drift, prompt bloat and learned errors. |
| CORE-009 | Proposed | Skills can be added and selected by task; do not replace unrelated capabilities. | Future copywriting/social/animation courses augment competence. |
| CORE-010 | Recorded | Start laptop-only, source-backed and host-triggered; a customer-key API adapter, the remote gateway, publishing, scheduling and analytics are deferred. Owner/default runs are subscription-only and refuse API keys (see the [owner policy](operations/AUTHORITY-AND-CAPABILITY-STATUS.md#owner-policy-2026-11-14)). | Keeps the owner on subscription-only bring-your-own AI. |
| CORE-011 | Proposed | Google Drive PARA-style workspace and living index, not a PDF-only inventory. | Portable organized source material with current links and statuses. |
| CORE-012 | Recorded | No agent can approve its own public side effects; current inbox approval binds the exact private version and never publishes. | Publishing remains deferred and would need a separate destination approval. |

| CORE-013 | Recorded | Keep the legacy CLI Director beside the generated MCP Director until Service parity. | The CLI still owns sessions, evidence, captures, revise, cancel and the live local Claude route. |
| CORE-014 | Recorded | Service proactive work is triggered by owner host scheduled tasks, not a Studio scheduler. | Current Service only scans, accepts ideas and creates pending inbox requests. |
| CORE-015 | Recorded | The owner never pays for API usage: owner/default runs use a Claude/Codex subscription and refuse API keys. An API adapter for customers who bring their own key is deferred, not rejected. ADR-003 stands; its API-adapter plan is for those customers. | `model-port.ts` refuses API-key environments; the roadmap keeps the customer adapter. |
| CORE-016 | Recorded | Series pieces are approved by tenant `review_policy`: `passkey` (default, inbox assertion) or `linear-review` (named-account marker, `authenticated:false`). | Matches `program-store.ts`; a Linear login cannot prove the owner was present. |
| CORE-017 | Recorded | Studio never holds a Linear token; the host's Linear connector reads and writes, and the Service only sees typed change sets and receipts. | Keeps third-party credentials out of Core and the Service. |
| CORE-018 | Recorded | Publishing always needs a passkey final plus destination authorization; `linear-review` finality never satisfies it. No publisher exists. | `publishGate` rejects linear-review finals; nothing publishes today. |

## Revision protocol

For each new feedback item:
- Record source/asset/version, observation, impacted capability, hypothesized root cause.
- Propose the smallest skill/workflow change, not a global ban unless warranted.
- Re-evaluate fixed examples and real current work, report tradeoffs.
- Approve or reject the change; preserve old version and rollback path.
- Add dated version entry explaining why, and link to related PR or issue.

## Open questions

- Which account, location and access policy will host the first business's Drive workspace?
- When to introduce a private transcript-capture connector per chat runtime?
- Whether and when to formalize a custom Linear agent instead of using existing connectors/manual interactions.
- Which criteria and samples indicate the newsletter specialist outperforms the legacy writer?
- How to package the core as a CLI without licensing/privacy mistakes?
- What production runner/database and authentication mechanism fit future autonomy and users?

## Version history
- v0.3: first separate clean reusable core repository. Historical architecture only.
- 2026-11-12: current-state reconciliation recorded the CLI/Service split, pack/eval implementation, host-triggered proactive policy and deferred API/hosting/publishing policy. See [BUILD-LOG](BUILD-LOG.md).
