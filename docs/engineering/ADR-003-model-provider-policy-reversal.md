# ADR-003 — Model-provider policy reversal

**Status:** Recorded on `main`; API adapter and billing remain deferred by owner policy.
**Date:** 2026-11-12 PT  
**Clarified 2026-11-14:** this ADR is not superseded. The owner never pays for API usage, so owner/default runs stay subscription-only and refuse API keys; the API-backed ModelPort below is for customers who bring their own API key, and remains deferred on the roadmap. The Service also has a subscription-backed `codex-cli` ModelPort now (see [Architecture](../ARCHITECTURE.md)). See the [owner policy](../operations/AUTHORITY-AND-CAPABILITY-STATUS.md#owner-policy-2026-11-14).  
**Supersedes:** The provider recommendation in [ADR-RUN-001](ADR-001-runner-execution-stack.md) once the owner approves billing.

## Context

ADR-RUN-001 chose a provider-neutral ModelPort with an SDK-backed real adapter. The v0.7 implementation instead shipped a subscription-only `claude-code-cli` adapter, refuses `ANTHROPIC_API_KEY`, has no API provider dependency and does not accept Codex/OpenAI as a model provider. That is a valid local draft mode, but it cannot support unattended or hosted runs with accountable spend.

## Decision

Keep `claude-code-cli` for the current local, user-triggered path. Plan an API-backed ModelPort for the Service milestone, with explicit per-run and per-tenant-month USD budgets, recorded usage and fail-closed budget exhaustion. The owner must decide whether API billing is acceptable, including the budget policy and provider account, before that adapter is enabled.

## Consequences

The current release makes no API calls or billing claims and remains local-only. Hosted, unattended and multi-tenant execution stay out of scope until the API adapter, budget enforcement and owner billing decision are implemented and tested. A subscription login is not treated as API authorization.
