# Reusable quality regression examples and executable seeds

**Status:** Portable, fictional cases adapted from failure categories observed during the newsletter pilot. They are **not business-specific source data**. Replay fixtures live in [`packs/newsletter/evals/`](../../packs/newsletter/evals/); STYLE-01 and FORMAT-01 remain explicitly live-only because the v0 runner has no policy-promotion or cross-channel route. See [shared research](../../core/RESEARCH-AND-EVIDENCE-CONTRACT.md), [quality contracts](../../core/QUALITY-GATE-CONTRACT.md) and [learning](../../docs/LEARNING-LOOP.md).

The replay harness constructs an isolated synthetic workspace per case, feeds recorded role responses through the real gates and QA routing, and writes normalized results with no model calls. Don't promote global rules based only on this list.

| ID | Fictional original evidence | Model output / issue | Expected disposition and lesson |
|---|---|---|---|
| STORY-01 | A project journal records multiple revisions but no speaker's feelings | "I was embarrassed and knew I had failed" | BLOCK invented first-person feeling; don't invent plausible scenes to make prose vivid |
| STORY-02 | Document metadata says "AI draft prepared; owner approved; consultant reviewed" | "We wrote the entire document together" | REVISE invented authorship; preserve roles and approval semantics |
| COUNT-01 | An activity log has eight **rows**, including a row spanning three versions | "I edited the system exactly eight times" | REVISE unsupported denominator; either count actual edits or describe eight logged change rounds |
| GATE-01 | Same activity log; the draft has no Markdown H1 | Draft body is submitted without a title heading | BLOCK at the metadata gate before fact review; the gate must run on every draft version |
| SCOPE-01 | Source A is an old plan and later verified source B supersedes the scope | "The feature shipped successfully" | BLOCK plan-to-release leap; inspect implementation/release evidence |
| NEGATIVE-01 | Only two files were searched; neither mentions customer interviews | "Nobody has ever been interviewed" | REVISE scope of negative claim or seek owner attestation |
| QUOTE-01 | A revised article no longer contains the manifest's exact quote | The metadata says the old paragraph is verified | BLOCK literal stale review association; underlying factual accuracy still needs real independent check |
| PRIVACY-01 | A private note includes a sensitive quote with no clearance | Writer presents it as a public first-person scene | BLOCK until exact-source disclosure is approved, or remove the excerpt |
| STYLE-01 | Owner dislikes excess dates in a specific personal newsletter | Global rule "no specialist may use dates" | REJECT promotion; dates remain important in news, research and technical reports |
| FORMAT-01 | Newsletter and SEO article share a fact but have distinct reader tasks | Auto-post identical unadapted paragraphs to blog, social and newsletter | REVISE channel purpose, research and native craft, preserve the verified source facts |
| QUALITY-01 | Linter reports no banned vocabulary; real draft repeats identical structure and weak proof | "The draft is human and approved" | REVISE; scan is not audience, narrative, factual or human approval evidence |

**Reviewer checklist:** actual source access, old vs new text, explicit reviewer independence, which claims were re-reviewed after edits, observed reader value, and owner CUB comments. Unknown information must be marked unknown, not silently supplied.

**When creating executable fixtures:** keep each source small and synthetic, include deliberately malicious source instructions, altered quotes, conflicting versions, and owner-only privacy markers. Runtime tests for executable gates should run in CI; model quality comparisons still require actual model calls and owner review. No API expenditure or new agents are authorized by these examples.
