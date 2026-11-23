# Model and subagent routing policy — capability first, cost-aware

**Status:** Proposed dispatch policy; no production subagent spawner or model router currently exists.

## What is routed

**Main Director** decides the *task* and delegates to bounded specialists (research, newsletter, SEO, design, video, fact review, /unslop, engineering, reliability). The **runner** determines how to invoke an available provider/model for that role with budget and permission limits, recording actual execution.

Selecting a model is part of the main agent's delegated responsibility, subject to system policy—not an arbitrary hardcoded “always use Opus” rule. Provider models evolve. A capability registry should be measured and configurable per tenant/runtime.

## Routing classes

| Class | Typical task | Expected capability | Initial rule |
|---|---|---|---|
| T0 deterministic | Parse Markdown, compare URLs, calculate token/cost budget, validate JSON, run tests | Code, no LLM | Default here before invoking any model |
| T1 economical | Classify ideas, tag sources, deduplicate, compile source inventory, propose low-risk titles | Fast, low cost, structured outputs | First choice when outcome is easy to verify |
| T2 balanced | Focused research synthesis, brief drafting, issue revision, independent FAQ, routine engineering under tests | Solid reasoning and writing | Default generation tier |
| T3 high reasoning/creative | Complex campaign strategy, conflicting evidence, long multi-document planning, nuanced editorial voice, nontrivial code design/debugging | High-reliability reasoning, longer context | Escalate when risk/uncertainty/novelty justifies it |
| T4 explicit premium | Critical architecture migration, difficult cross-system failure, complex code security reasoning, substantive multi-agent dispute | Max available reasoning ability, cost guard | Owner-configured or evidence-triggered escalation; no claim every provider has a T4 |

**Provider examples:** Claude Opus, OpenAI GPT reasoning modes, other models with required capabilities may be tested against the same tasks. Do not equate provider branding ("Sol", "Opus") with a stable capability or universal quality rank. Register available model ID, price, context window, modalities, tool support, observed quality, privacy rules and quotas at execution time. ChatGPT and Claude Code may expose different controls.

## Escalation and parallelism

- Start with the least costly tier likely to meet the task's required quality. A failing check (missing sources, malformed schema, reasoning contradiction, unacceptable style) triggers a *diagnosed* retry or escalation, not an unlimited loop.
- High-stakes fact checks should be independent of the original writer when feasible; cheap duplicate same-model "looks good" feedback is weak evidence.
- Parallelize **independent** tasks (e.g. product research + competitor newsletter scan) when it lowers elapsed time and respects total token budget. Don't spawn several agents to brainstorm the same vague task without clear purpose.
- Reserve T3/T4 for Director resolution, complex evidence and a small number of high-impact creative/reliability decisions, instead of every extraction.
- Explicitly record model, task type, cost, latency, source use and QA result. Use evals to calibrate tier thresholds.
- On failure: return partial artifacts, diagnosis and next step; don't fake a successful subagent.
- Cache source summaries with version/expiry and privacy scope; invalidate on upstream changes. Avoid paying to re-read unchanged entire repositories every time.

## Budget and stop controls

At task creation, the Director/runner sets per-run model-call/step/time budget and maximum depth; define a reserve for factual QA. The runner enforces concurrency, retries, rate limits and provider fallback. If actual spending approaches the budget, pause and ask the owner whether to increase it rather than silently reducing standards or publishing incomplete work. No provider keys in shared GitHub.

## What to test before enabling

- Same source/brief, compare T1–T3 models for claim accuracy, usefulness, voice, cost and latency, with owner CUB notes and independent source check.
- One case requiring T3 (contradictory specs) and one ordinary case that should remain T1/T2.
- Provider unavailable mid-run: can resume on another model using the same stored source/decisions, preserving provenance and permissions.
- Run with exhausted budget: no hidden extra retries.
- Different specialist tasks can use different models without changing the portable skill files.

Model router is an implementation plan, not evidence that the current chat can automatically spawn arbitrary provider subagents. The **new agent service** must explicitly implement provider tools and sandbox isolation.
