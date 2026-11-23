# ADR-002 — Studio Service owns state, authority and MCP

**Status:** Implemented on `main`; owner policy remains laptop-only; Service execution uses fixtures by default or a tenant-configured subscription provider.
**Date:** 2026-11-12 PT  
**Scope:** The boundary for the next Marketing Studio runtime milestone.

## Context

The architecture review's sections 1 and 3 separate the existing Runner execution engine from the product boundary it cannot safely provide. The current local files, stdio MCP process and owner quotes are useful draft-only mechanisms, but a shell-capable model process can write the same workspace state. They are not an owner authority boundary.

## Decision

- Keep the Runner engine as a reusable library; wrap it in one long-lived Studio Service that owns run state, tenant mapping, policy checks and MCP transport.
- MCP and model-reachable tools may create requests or pending records, but must not directly create owner decisions, grants, revocations or publish authority.
- Only a separate owner channel, outside the model's driveable process and protected by real owner authentication, may write authority records and turn pending requests into decisions.
- Treat the tracked authority milestone (owner-only authority) and the tracked authority milestone (authenticated remote boundary) as one boundary problem. Local and remote deployment choices may differ, but neither may claim authority until the Service and owner channel enforce this separation.

## Consequences

The local Runner remains useful for trusted fictional or nonsensitive draft work, but it must not be presented as a sensitive-data service. A future Service can add asynchronous runs, tenant-aware state and authenticated MCP without moving authority into model prompts. The owner channel, not an MCP tool or owner quote supplied by a model, is the approval source.

The Service, signed authority store, passkey inbox and loopback MCP are implemented. Hosted transport and same-OS-user isolation remain follow-on work before sensitive tenant data. VULN-1/VULN-7b remain legacy CLI limits; the Service route closes the corresponding workspace-forgery path for its own authority.
