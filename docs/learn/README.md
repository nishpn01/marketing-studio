# Learn Marketing Studio

Six short chapters for someone who will own this system, not just use it. They start from what an agent is in this codebase and end at how a change is proven safe. Each chapter cites the files that implement the idea and ends with a command you can run offline.

Read in order. Later chapters assume the earlier ones.

| # | Chapter | One-line answer |
| --- | --- | --- |
| 1 | [Agents and pipelines](01-agents-and-pipelines.md) | One role invocation is one model call with a fixed prompt, skills, task, and output shape. |
| 2 | [Durable runs](02-durable-runs.md) | Finished steps are recorded, so a crash does not repeat work. |
| 3 | [Trust and approvals](03-trust-and-approvals.md) | A file is not an approval. A signed, digest-bound passkey assertion is closer. |
| 4 | [MCP and hosts](04-mcp-and-hosts.md) | Claude or Codex is the conversation. The Studio is the state and the guardrails. |
| 5 | [Packs and specialists](05-packs-and-specialists.md) | A specialist is a data pack over one shared runner. |
| 6 | [Evals and improving](06-evals-and-improving.md) | A prompt change is not accepted unless the recorded behavior still holds. |

## Branch status

All six chapters describe code in this branch after the merge of main: the runner, the durable store, the local MCP server, the Service authority layer, capability packs, and the eval harness.

The commands in every chapter run here. Chapters 5 and 6 no longer need their own branches.

## Glossary

- **Role**: a named job in the pipeline (`director`, `writer`, `fact_reviewer`, `craft_reviewer`), with its own prompt and skills.
- **Pack**: a folder that declares roles, output schema, gates, rubric, and budget for one specialist.
- **Run**: one production attempt, stored in `.studio/` with events and artifacts.
- **Receipt**: the record that a model call happened, written before the result is trusted.
- **Gate**: a mechanical check on output, such as word count or exact claim quotes.
- **Eval case**: a recorded request and responses plus expected behavior, replayed deterministically.
- **Authority record**: a signed row that grants or records a decision. Only the owner channel writes it.
- **Pin**: a hash of a prompt, skill, or source at the time a run started. A changed pin means the run is not comparable.

## Where to go next

- [Getting Started](../GETTING-STARTED.md) for the first conversation.
- [Architecture](../ARCHITECTURE.md) for the full diagram and boundaries.
- [Security and disclosure](../security/SCOPED-DISCLOSURE.md) for the limits of local trust.
- [Learning loop](../LEARNING-LOOP.md) for the change protocol behind chapter 6.
