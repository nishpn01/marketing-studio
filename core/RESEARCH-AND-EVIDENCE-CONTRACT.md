# Shared research and evidence contract

**Scope:** Cross-specialist design contract, not a research agent or connector; implemented behavior is recorded in the [current architecture](../docs/ARCHITECTURE.md). Applies to newsletter, blog/SEO, social, video, campaigns and future specialists.

## Responsibilities

The **Director** collaborates with the owner, develops strategy, chooses what is worth researching and can say no to weak ideas. **Research work** retrieves and compares permitted evidence. A **specialist** applies domain craft to a brief. An **independent evaluator** reopens the originals. The **Runner** will enforce tools, isolation, state and cost, not editorial strategy.

A common evidence packet can serve different formats when the **claim, original source version, audience and permissions** remain appropriate. Reusing evidence does not justify copying the same article to every channel.

## Minimum research packet

For a substantial asset or campaign, create the fields below in a versioned, permission-scoped packet. A tiny one-off can use a lean subset with explicit missing information; do not invent competitor research or customer quotes to fill blanks.

| Field | Research task | Guardrail |
|---|---|---|
| Origin and intent | Owner wording, source pointer and whether it was brainstorming, an instruction or accepted decision | A brainstorm is not publication consent |
| Business and product truth | Verify what actually works, what is planned, when the source was valid | A PRD or draft is not launch evidence |
| Reader | Define reader question, awareness, and direct audience/voice-of-customer evidence or its absence | Model-generated personas are hypotheses |
| External context | Compare credible explanations, expert methods, competing content and current trends where relevant | No fixed three-competitor quota |
| Source ledger | Stable ID, original URI, revision/hash, kind, quote locator, visibility, allowed disclosure | Generated summaries are not original proof |
| Uncertainty and contradiction | Conflicting stories, unresolved timelines and absent evidence | Qualify, omit, corroborate or escalate |
| Angles | Distinct value, proof and feasibility; Director's recommendation with trade-offs | Director may recommend skip |
| Strategy checkpoint | Proceed, research further, park or skip, with reasons and owner decision if relevant | No self-approval of major changes |
| Handoff | Reader problem, evidence, exclusions, claims, approved disclosures and format-specific quality criteria | Minimize specialist source access |

**Format-specific additions:** SEO needs query intent, results and information gain; social needs platform audience context and independent utility; video needs visual evidence, production rights and pacing; newsletter needs relationship promise, content form and sustained clarity. No format bypasses shared truth/privacy checks.

## Truth boundaries

A prior generated article, model-written journal, a long URL list or a model saying "verified" is not factual evidence. An AI cannot invent an author's personal feelings, conversations, results, product launch or testimonials. Owner approval of an angle does not authorize disclosure of private source passages.

Separate observations, inferences, plans, verified implementation and owner-only attestations. Explicitly record absence of evidence instead of treating an unsupported negative as a universal truth.

## Gates and efficiency

**Before drafting:** the Director has an evidence-backed, worthwhile angle, an explicit reader hypothesis and a source/disclosure plan. Research more or skip if the story is too thin.

**Before owner review:** claim-to-original source tracing and independently run fact/privacy plus domain-craft reviews are recorded. The mechanical gate does not certify truth.

**Before publication:** separate owner approval authenticates the exact asset version, destination and intended action.

Retrieve only relevant sources, pin version IDs, cache summaries with tenant privacy, and invalidate checks when a primary source changes. Use deterministic tooling for extraction/validation, an economical appropriate model for bounded research, and reserve reviewer budget. A new ChatGPT/Codex/Claude session receives explicit links and approvals, never presumed cross-provider chat memory.

## Relationship to existing contracts

- [Studio Director](DIRECTOR.md) owns creative planning.
- [Portable specialist](SPECIALIST-CONTRACT.md) owns domain craft.
- [Shared quality and review](QUALITY-GATE-CONTRACT.md) defines claim, craft and owner gates.
- [Selected copywriting research adaptation](../skills/copywriting/RESEARCH-WORKFLOW.md) is an optional professional method, not an exclusive shared workflow.
- [Learning loop](../docs/LEARNING-LOOP.md) governs proposed skill changes.
