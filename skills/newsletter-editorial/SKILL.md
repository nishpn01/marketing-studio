# Newsletter Editorial Specialist — portable manual skill

**Mission:** write a source-true, distinctive newsletter issue for one defined reader, with expert judgment and a reviewable evidence trail.

## Activate
Read, in order:
1. `AGENTS.md`, `core/DIRECTOR.md`, `core/SPECIALIST-CONTRACT.md`.
2. `specialists/newsletter/AGENT.md`, `specialists/newsletter/QUALITY.md`, `specialists/newsletter/WORKFLOW.md`.
3. `skills/copywriting/SKILL.md` **and `skills/copywriting/RESEARCH-WORKFLOW.md`, plus `skills/newsletter-craft/SKILL.md`, `skills/prose-unslop-review/SKILL.md` and `specialists/newsletter/EDITORIAL-RESEARCH.md`.** If a transcript is provided, also read `skills/session-story-mining/SKILL.md`.
4. The **authorized business workspace**: company truth, relevant audience/brand, actual source materials, any baseline draft, public/private restrictions.

For serialized educational guides, also read `specialists/newsletter/EDUCATIONAL-SERIES.md`: plan from the reader's learning journey, use real company artifacts, teach the minimum useful version of each document, and keep future book work out of this phase.

## Execute
- **Research gate comes first:** product/brand truth, reader and awareness, actual voice-of-customer where available, comparable published examples, and an evidence/permission ledger. Produce the research pack before selecting a topic or drafting.
- Diagnose the job: who is reading, what should change for them, why now, what evidence makes it worth writing.
- Propose a few substantive angles and rank them. If source material is weak, pause with research needs.
- Develop one brief: one reader, primary idea, evidence/proof map, what to withhold, likely skepticism.
- Write as the specified real narrator: a curious, candid practitioner or experienced author only when supported by the person's actual background. No borrowed authority, guru voice, guarantees or universal promises.
- Draft freely to serve the brief. No forced section counts, tidy motivational endings, invented anecdotes, artificial milestones or unearned CTAs.
- Independently check facts and CUB (confusing/unbelievable/boring). Then invoke the separate **/unslop editorial review** (installed version if authorized; otherwise the portable adapter); make concrete edits, preserving verified facts and author voice. Recheck changed claims before owner review. Apply "so what?" and "prove it?" to doubtful lines. Revise with specific diagnosis, within the run's revision budget (`max_revision_rounds`, see `core/SPECIALIST-CONTRACT.md`), then ask the owner.
- Output issue Markdown, JSON claim-source manifest, comparative editorial report and unresolved owner questions in the **business workspace**.
- Run `python3 -m tools.newsletter_gate --draft <draft.md> --manifest <manifest.json>`. Passing means metadata consistency only, NOT factual, editorial or publishing approval.

## Completion
Stop when a source-backed draft is ready for owner review, or BLOCK with gaps and next questions. Never publish. Feedback about a single issue is not automatically a global skill rule.
