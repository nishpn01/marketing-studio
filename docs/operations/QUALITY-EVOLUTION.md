# Continuous improvement and reliability engineering policy

**Status:** Proposed system-level governance, Nov 10 2026. Current implementation is a document-backed/manual feedback loop. Automated evaluation monitoring and self-upgrade runner do **not** yet exist.

## Two operating layers and three loops

1. **Editorial quality loop (per asset)** — research, source validation, drafting, independent subject/craft QA, /unslop if relevant, owner feedback, local revision, preserve before/after.
2. **Business outcome loop (per campaign)** — with publication authorization, capture real comments/corrections/engagement/reader outcomes; form bounded hypotheses and test them. No guarantee that an open rate measures content usefulness.
3. **Engineering reliability / skill evolution loop (for Studio itself)** — collect recurring failures, classify cause, propose smallest targeted rule/skill/tool/workflow change, evaluate under fixed tests and cost, compare old/new, promote or rollback with governance.

## Improvement taxonomy

| Feedback category | Default action | Who may approve |
|---|---|---|
| Local correction ("This sentence sounds generic") | Revise this exact asset, cite diff, retain fixture | Owner editorial approval |
| Repeated craft failure across several issues | Propose revision to Newsletter Craft or /unslop evaluator, with before/after test | Versioned specialist skill review |
| Topic research or audience gap | Improve research method or tenant source bank, not global prose rules | Director / owner as appropriate |
| Tool failure, API drift, duplicate task, lost context | Engineering bug ticket → test → isolated code PR → monitored rollout | Maintainer/release gate |
| Model routing or cost degradation | Benchmark alternate providers on same fixtures; propose routing policy revision | Budget/reliability gate |
| Core structure or trust boundary changes | Architecture Decision Record with alternatives, migration and safeguards | Explicit owner architecture approval |

**Foundational principle:** Observation → diagnosis → scoped proposal → regression evidence → approval → promotion → monitor → rollback if needed. Avoid prompt-bloat by deleting obsolete rules and keeping scope explicit.

## Change control with objective evidence

Required change proposal:
- Trigger and concrete examples (source URI and owner comments).
- Classified root cause; competing hypotheses (bad topic, missing source, model weakness, tool error, instruction conflict).
- Change surface: **asset / tenant style guide / specialist skill / tool / orchestration / core architecture**.
- Hypothesis and measurable acceptance criteria.
- Fixed evaluation set of **positive, negative and cross-topic cases** (e.g. two newsletter issue types and one unrelated SEO task for isolation).
- Candidate diff, skill versions, model versions, cost/latency and QA results.
- Regression risks: loss of nuance, factual edits, source leakage, worse SEO or code behavior.
- Human/authorized maintainer acceptance and rollback pointer.
- Post-promotion monitoring for new failure patterns; route suspicious outcomes to review, not instant self-modification.

No universal numerical "quality score" is trusted alone. Combine: evidence validity (hard gate), human CUB feedback, reader task success, privacy, editing density, novelty, proportionate length, and consistency across tasks.

## Autonomous behavior boundaries

Allowed future autonomous actions **with explicit per-workspace permission:** collect authorized metrics and owner comments; detect repetition or source contradiction; make a hypothesis; run isolated tests; create a Linear issue; open a draft skill/code PR; report results.  
Protected actions requiring human gate: merge shared core changes, alter source-of-truth business claims, cross-tenant data moves, connect an API provider (owner runs refuse API keys), publish/send, change accounts or permissions, silently override an approved creative strategy.

Even accepted skill changes may need a canary run; compare outcomes against the baseline, monitor cost and factual accuracy, and revert to pinned known-good version on regressions.

## Degradation and operations controls

- Scheduled health checks: broken source links, stale decisions, new source conflicts, stuck Linear tasks, failed model/provider calls, repeat loops, orphan draft versions, unauthorized scope expansion.
- Per-run budget, retries, timeout, stop conditions, human escalation and a provider fallback policy.
- Traces: owner objective, sources consulted, decisions made, subagents spawned, tools called, skill versions, review disposition, changes, cost/latency, external receipts.
- Quality drift alert: repeated owner rejection, rising fact errors, increasing generic prose or latency/cost. Gather evidence before making changes.
- Maintain test fixtures: rejected "AI slop" drafts, owner-approved examples (once approved), prompt injection/fake-source cases, contradictory version histories, changed strategy/future idea tests, broken publishing idempotency.
- No background monitoring claim until a scheduler, store and alert destination are actually installed and tested.

## Responsibilities

- **Studio Director:** strategy, prioritization, choice of specialist, owner collaboration, feedback escalation.
- **Editor / Evaluator:** independent source, voice and craft check; feedback classification; proposes tested skill improvements.
- **Engineer / Builder agent:** isolated code/adapter/test changes under scoped repo permissions; emits PR and technical evidence.
- **Maintainer / Reliability agent:** monitors workflow health/quality drift/cost; manages incident reports, regressions, canary tests and rollback proposals.
- **Runner:** executes bounded tasks and invokes appropriate agents using actual authorized tools; does not decide business content.
- **Owner:** approves editorial voice/disclosure, strategy changes, architecture and publication permissions.

This is a management system for improving agents, not a new prompt that asks the writer to “self-improve” at the end of every issue.
