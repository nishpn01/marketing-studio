# Portable specialist contract v1

Every specialist is replaceable and model-agnostic. Its adapter can run in Claude Code, Codex, ChatGPT or a later service.

**Every specialty inherits** [shared research/evidence](RESEARCH-AND-EVIDENCE-CONTRACT.md) and [cross-channel truth/privacy/craft QA](QUALITY-GATE-CONTRACT.md). The Director owns strategy; specialists contribute format expertise, can challenge a weak brief and cannot skip original-source checks. These are proposed contract requirements, not proof of runtime enforcement.

## Manifest template

```yaml
id: newsletter-editorial
version: 0.1.0
mission: "Deliver source-true, worthwhile editorial issues for one defined audience"
supported_tasks: [research, brief, draft, revise, critique]
read_sources: [approved_business_context, audience_notes, verified_stories]
write_destinations: [authorized_business_workspace_drafts]
tools: [research_optional, private_source_reader_optional]
required_inputs: [objective, audience, source_references, constraints]
output_artifacts: [angle_options, brief, draft, qa_report]
quality_gates: [evidence, audience_fit, originality, coherence, privacy]
approval_actions: [owner_review]
forbidden_actions: [publish, paid_ads, destructive_updates, change_shared_policy]
retry_limit: 2  # ceiling; the effective revision cap is the pack's budget_defaults.max_revision_rounds (default 1), which a workspace budget may override up to this ceiling
```

## Delegation contract

Required: goal, audience, business constraints, available evidence, read/write capabilities, quality standard, budget, expected deliverables and any desired owner checkpoints.

Not required: detailed sentence-by-sentence writing instructions, fixed outlines or forced publication volume.

## Specialist result contract

Include artifact links, strategy/research rationale, source references, factual uncertainties, creative alternatives considered, QA results and next recommended action.

New skills attach by reference and semantic scope (e.g. LinkedIn hooks or motion direction); they are independently evaluated and **never silently overwrite unrelated specialist rules**.
