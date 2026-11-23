# Controlled improvement — learn without self-corruption

## Principle

An LLM's assertion "this draft is better" is **not evidence** of improvement. Capture the owner's feedback, expert critic observations and real-world outcomes as separate inputs; propose narrow changes; use repeatable evaluations and human review before promoting changes.

## Learning record fields

```yaml
id: learn-0001
scope: newsletter
source_kind: owner_feedback # specialist_qa | outcome_metric | formal_course
source_reference: private-workspace-link-or-anonymized-fixture
asset_version: v1
observation: "Sections feel formulaic"
hypothesis: "Writer workflow prescribes one rigid outline"
candidate_change: "Allow issue shape to follow actual story"
tests:
  - prior_known_bad_example
  - independent_story_example
status: proposed # tested | accepted | rejected | reverted
reviewed_by: owner
date: YYYY-MM-DD
```

## Update protocol

1. **Capture raw evidence** without asserting causality.
2. **Classify:** factual failure, weak research, missing narrative specificity, audience mismatch, creative preference, tool failure or strategy issue.
3. **Choose smallest scope:** this asset, this audience program, this specialist, shared skill, or system policy. Never generalize a local preference by default.
4. **Propose change on an isolated branch or skill version** with the old rule visible.
5. **Run regression pack:** at least two fixed examples plus the current example, including factual source traceability and a qualitative owner comparison. Source-backed assertions must not be generated from older drafts as truth.
6. **Promote only if benefit exceeds regressions**, record rationale/approval, maintain a rollback path. Otherwise reject or revise the hypothesis.
7. **Periodically consolidate:** remove redundant, conflicting or superseded rules with a changelog; keep examples not repeated paragraphs of instruction.

## Two content loops

- **Short production loop:** source-backed brief → draft → independent source and craft review → bounded revision attempts → final owner review.
- **Long performance loop:** publish with approval → wait appropriate period → inspect real reader/customer response and metrics → change one hypothesis → measure again. SEO can require weeks; newsletters may have a different learning window.

Differentiate intrinsic craft (accuracy, originality, relevance) from market response (clicks, signups, unsubscribes, conversions). Product-market fit is a broader company outcome; don't falsely infer it from one post's metrics.

## Built-in anti-bloat controls

- Explicit skills and versions; no uncontrolled prompt append-only behavior.
- Scoped retrieval and an authoritative source hierarchy.
- Generated content and summaries never count as primary proof.
- Feedback attached to original example/version; no anonymous "the model learned" claims.
- Contradiction and outdated rule review on each promotion.
- Stop and escalate when edits repeatedly fail.

No automatic code/prompt policy changes or self-publishing are enabled by this design.
