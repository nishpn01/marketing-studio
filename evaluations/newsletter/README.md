# Newsletter evaluation

**New cross-channel proposed foundation:** [shared research](../../core/RESEARCH-AND-EVIDENCE-CONTRACT.md) and [quality](../../core/QUALITY-GATE-CONTRACT.md). The current Python validator now checks literal claim quotes when they are provided and warns on omitted quotes; it still cannot authenticate reviewer identity, discover omitted facts or compare a claim with its original source.

The automated gate in `tools/newsletter_gate.py` validates **metadata consistency only**, not style, source truth or owner approval. Run `python3 -m unittest discover -s tests -v` for synthetic test cases. Run `python3 -m tools.newsletter_gate --draft ... --manifest ...` inside an authorized private business workspace.

Required comparative evaluation: source truth, one reader and idea, originality of insight, usefulness, narrative integrity, specificity, voice, privacy, and source-cleared claims. Independently highlight CUB (confusing, unbelievable, boring). Owner judgment is not replaceable with a made-up AI score. All real user artifacts remain outside this core.
