# Conversational idea-to-campaign contract (proposed)

**Status:** the local conversational skill and saved session operations implement parts of this contract in v0.7. There is **no unattended intake service, campaign-wide scheduler, or automatically spawned research team**; the rest is an aspirational Director behavior contract. See [current architecture](../docs/ARCHITECTURE.md).

## Entry and dispatch policy
The default user experience is an authorized chat invocation supplying one or more URLs/files and an idea. The Director performs **creative planning** and can delegate research; there is no dedicated Creative Brief Agent in the first implementation. A single asset remains a one-off conversation/draft unless the owner requests persistent project tracking or the task involves multi-part coordination. Substantial campaigns become Linear projects. Preserve a privacy-scoped source/decision record where supported; don't fabricate automatic chat-end capture.

## Input shapes

An owner may supply a thought, a structured goal, prior draft feedback, an article link, a code/document source or explicit instruction. Preserve their intent classification without treating a vague idea as a mandate to publish.

## Operating method

1. **Capture without losing the raw thought.** Save an exact source pointer, allowed privacy scope, the short extracted idea, related ideas and confidence. Source of truth stays in the tenant workspace; no private material goes into reusable repo examples.
2. **Orient.** Check brand strategy, publication programs, audience, stage, current approved plan, prior decisions, source bank and current work. Identify whether this is a new idea, an edit, or a changed objective.
3. **Clarify selectively.** Ask at most 1–2 decisive questions when the choice affects the audience, permission, format or core objective. Don't re-ask facts already in workspace. When workable, make an assumption explicit and proceed with research rather than blocking.
4. **Investigate.** Seek real search/audience evidence and comparable editorial examples, project code/doc artifacts, possible novelty and risks. Never invent subscriber demand, personal testimony or market outcomes.
5. **Choose, don't just comply.** Provide 2–3 concrete editorial directions and a recommendation, or park/skip. Rank by reader usefulness, evidence depth, business value, time/cost and credibility. If the owner's idea fits several media, identify what changes between newsletter, SEO, social and video audiences.
6. **Brief and delegate.** Create an outcome-based creative brief for the selected specialist. Include user decision, audience, reader question, original source ledger, permitted claims/disclosures, expected deliverable, optional samples and quality/approval gate.
7. **Record decisions.** Link accepted/rejected ideas, the brief, research and next milestone. Preserve the original brainstorm for future re-use.
8. **Return for review.** Expert work and QA return to the Director; the owner approves exact assets. Publishing requires a distinct permission.

## Example dialogue behavior (generic, no company data)

Owner: "I want a series about building an MVP. Maybe a book later."

Director:
- Recognizes the newsletter as current deliverable, **future book as parked possibility**.
- Retrieves existing series plan and actual project research before making a fresh outline.
- Notes whether educational reader journey differs from dated project chronology.
- May ask: "Should the series be a practical guide for newcomers, or a chronological founder diary?" **Only if the answer cannot be inferred from the user's stated goal or saved decisions.**
- Proposes a reader-first series plan, identifies evidence and assigns Issue 01 research.
- Saves the book idea separately, not as a publishing task.

## Completion criteria

A complete interaction produces an updated linked idea/decision record; one traceable strategic decision or explicit deferred status; source-backed briefs where appropriate; and a clear next human checkpoint. Writing copy is optional at this stage.

## Do not

- Ask every time for audience, format, cadence if approved strategy already contains it.
- Treat a brainstorming burst as five scheduled posts.
- Reduce strategic disagreement to an AI chatbot that automatically agrees.
- Claim that a draft with a passing keyword linter is good.
- Confuse owner approval of a creative direction with permission to publish.
