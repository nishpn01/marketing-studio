# Shared cross-channel quality and release gates

**Scope:** Portable quality design, not automated certification; which gates the Runner enforces is recorded in the [current architecture](../docs/ARCHITECTURE.md). Applies to newsletters, blog/SEO, social, video, campaigns and future specialists. Channel craft adds requirements but cannot bypass truth/privacy/approval.

## Separate gates with separate evidence

| Gate | Owner and checks | Result |
|---|---|---|
| Research sufficiency | Director and versioned evidence packet: actual reader question, original material, alternative angles | Proceed / research more / park / skip |
| Mechanical integrity | Deterministic validator: schema, source IDs, quote matching, current artifacts | BLOCK / metadata-ready, **not fact-certified** |
| Evidence and privacy | Reviewer separately retrieves original sources, compares exact claim scope/timing, reconciles contradictions and disclosure | BLOCK / REVISE / evidence reviewed, unresolved clearly marked |
| Craft and reader usefulness | A genuinely independent or explicitly non-independent editor: flow, specificity, interest, audience, original contribution, medium-specific norms | REVISE / ready for owner review |
| Owner content review | Owner reads exact draft/version, decides voice, disclosure and copy edits | Draft approved or revise; not publish authority |
| External publishing (future) | Separate authenticated owner authorization tied to version, destination and action; receipt/idempotency | Allowed only after distinct permission |

A model's own reviewer label or JSON field cannot prove independence or owner approval. A clean /unslop scan cannot prove good writing.

## Factual-review receipt

Save artifact exact revision/digest, source revisions, reviewer role/model and actual independence, IDs of claims checked vs. reused, original passages/locators, verdict per claim, owner-only attestations, privacy permissions, and any edits since review. Any materially changed claim must be rechecked. An absence claim ("no interviews happened", "never launched") needs explicit search scope or owner attestation, not merely absence in a few files. Quantified claims must have a reproducible denominator and appropriate scope.

## Editorial-review receipt

Assess one reader promise and whether it is met, complete-asset cohesion, originality/insight, relevance, evidence-backed specificity, clarity, voice, length relative to material, useful takeaways and appropriate media craft. Identify exact weak/strong passages and reasons rather than self-awarded numerical quality.

For audience feedback, real CUB (confusing, unbelievable, boring) must be clearly distinguished from a model simulation or a Director's own read.

## Additive channel-specific review

- **Newsletter:** compelling reason to open/finish, coherent progression, credible narrative/lesson, appropriate reader relationship and length, no rigid template.
- **Blog/SEO:** query intent, freshness, competitive coverage, original information gain, clear helpful structure, contextual internal links.
- **Social:** platform fit, one self-contained useful idea, responsible claim compression, not copied newsletter paragraphs by default.
- **Video:** source-to-script integrity, visuals rights, visual comprehension, timing, technical/render QA, platform context. A business that already has video domain checks keeps them in its own repo.
- **Campaign:** strategic continuity, distinct purpose per asset, audience progression, dependencies and approval statuses.

## Verdicts, retries and truth

- **BLOCK:** known factual falsehood, private disclosure risk, fabricated author experience, unsupported central premise, unauthorized publication or altered approval digest.
- **REVISE:** inadequate evidence for material inference, incoherent prose, misleading headline, weak reader value, avoidable jargon, channel mismatch.
- **READY_FOR_OWNER_REVIEW:** source/craft evidence and unresolved nonblocking notes presented, not a published asset.
- Limit repeat drafts; a recurring failure should trigger source/brief diagnosis and scoped improvement, not another expensive whole-repo reread.

The [Python newsletter metadata gate](../tools/newsletter_gate.py) checks structural metadata and an **exact draft quote when supplied**. It permits older manifests without draft_quote with warnings for compatibility with the local mock Runner. It never retrieves original sources, authenticates review labels or verifies content accuracy. Treat any output as at most metadata-ready.

**Verdict names.** The three verdicts above are the only gate verdicts. Other vocabularies map onto them and never exceed them:

| Where it appears | Value | Gate verdict |
|---|---|---|
| Craft reviewer JSON `verdict` | `ready` / `revise` | READY_FOR_OWNER_REVIEW / REVISE (a `must` finding means `revise`) |
| Fact reviewer claim `verdict` | `verified`, `unsupported`, `disputed`, `private_approval_required`, `not_checked` | Claim-level evidence only; any claim not `verified` keeps the draft at REVISE or BLOCK per the rules above |
| Metadata gate output | `READY_FOR_EDITOR_REVIEW` | Mechanical integrity passed (metadata-ready); not READY_FOR_OWNER_REVIEW |

## Improvement control

Capture concrete owner feedback + asset version; diagnose source, brief, model, workflow or style causes; propose the smallest scope; regression-test at least two distinct examples; obtain owner approval of rule/skill changes; retain rollback. An individual preference for fewer dates in a tenant newsletter must not silently become a global restriction on reporting or history.

Related: [Shared research](RESEARCH-AND-EVIDENCE-CONTRACT.md), [Learning loop](../docs/LEARNING-LOOP.md), [Quality evolution](../docs/operations/QUALITY-EVOLUTION.md).
