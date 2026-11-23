# Unslop editorial reviewer — portable skill adapter

**Purpose:** An independent post-draft editing skill for long-form newsletters and other narrative writing. It **augments** the Newsletter Craft, selected copywriting research, evidence review, and human reader feedback; it is not a replacement for them.

**Origin/reference:** [Cursor public pstack /unslop skill](https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md). On 2026-11-10 we inspected its current public guidance. The original is an external skill, **not installed into this core** and we cannot verify it is the same version the owner has in Claude Desktop. Link to it rather than copy the full external text. If an authorized runtime provides the user's own /unslop skill, use that installed version and record its path/version before QA. The referenced source sets manual invocation in its metadata; do not assume it runs automatically.

## Inputs

- Draft, publication/author voice profile, selected reader promise, source ledger and intended publication type.
- Optional original /unslop skill from the environment and previous negative editing examples.

## Editorial scan

Work through the prose. Identify passages with concrete line references; quote only brief excerpts in the review report.

1. **Generic vocabulary or filler:** abstract boosters, inflated adjectives, needless adverbs, formal substitutions for plain verbs, unearned opening or concluding claims.
2. **Template rhythms:** copy-paste section structure, each section the same length, repeated sentence openers, compulsory three-part lists, obligatory motivation or moral.
3. **Synthetic rhetoric:** forced "not just X but Y", fake contrasts, theatrical transition sentences, fluffy promise words, decorative metaphors or false drama.
4. **Unclear mechanism:** a claim that could appear in any company's newsletter; a vague benefit rather than an actual observable action, artifact, constraint, date or result.
5. **Punctuation/formatting tics:** unnecessary em dashes, colons connecting unrelated ideas, mass boldface, emoji decoration, inline header lists, overcompression and breathless short fragments.
6. **Voice:** can the actual author say this? Does it portray a curious practitioner or invent guru authority, inner feelings, direct dialogue or unmeasured outcomes?
7. **Substance:** are we mistaking a correct but thin article for a good one? If the source material doesn't support the argument, return to the researcher rather than rephrasing an empty sentence.

## How to edit

- **Detect → diagnose → choose a real edit.** Delete empty material; replace a generic line with a *verified* detail only if one exists; otherwise mark [NEED] or shorten the idea.
- Keep faithful source quotes, technical names, necessary repetition, genuine rhetorical contrast and distinctive natural speech.
- A mechanical flag is **not** proof that prose is AI-generated; useful human writing shares many patterns.
- Do not invent an anecdote, detail, opinion, source, statistic or reader reaction to make a passage less generic.
- Don't shorten a substantive issue merely to remove suspicious words; the previous pilot already failed because it was thin.
- Do not reintroduce the user's rejected style rules as a growing global list. Record examples in a scoped QA report; promote permanent rules only after a second-topic regression check.

## Output contract

- Verdict: BLOCK / REVISE / READY_FOR_OWNER_REVIEW (never "certified human").
- A concise table: exact excerpt, pattern, editorial reason, fix taken, and whether content evidence is still missing.
- Before/after draft version and identified regressions in truth, clarity and voice.
- Follow-up questions for the human reader: which passage confused you, sounded unbelievable or was boring?
- If passed: only **candidate for owner review**, not permission to publish.

## Composition in a working agent

Newsletter Agent → Research and angle → Draft → independent fact check → invoke original /unslop if available or this adapter → recheck facts and meaning → owner review. On material changes, go through the entire second check, not only a phrase search.
