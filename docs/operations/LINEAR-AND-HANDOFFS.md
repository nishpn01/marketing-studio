# Linear collaboration and model-agnostic campaign handoffs

**Status:** Architecture proposal, Nov 10 2026. Use tenant-specific Linear project URLs only in the respective private business workspace. A real autonomous Linear integration is **not implemented**.

## Three levels of work

| Granularity | Store / representation | When created | Examples |
|---|---|---|---|
| An unstructured thought / question / topic | Private **idea & decision ledger** with source pointer; optionally a Linear idea/backlog issue after owner interest | On permitted manual / future session capture. No project for every sentence. | "Maybe compare AI builders' product docs"; "book later" |
| A **one-off asset** / isolated task | **Current chat + saved private draft/source/QA**, with **optional Linear issue** if continuity or tracking is useful | By default no project; issue only for deliberate handoff/follow-up | Write one newsletter; research a single article; revise one email |
| A coordinated multi-asset campaign or implementation | **Linear project** with goals, source index, task/issue breakdown, progress and review gates | 4–5 connected newsletters, a product launch, a content series, infrastructure build, SEO campaign | Zero to MVP newsletter series; future Marketing Studio runtime |

Linear is the **operational collaboration and work queue**. The tenant idea ledger preserves captured exploratory thoughts and decision history, including deferred or rejected possibilities, whether or not they became Linear tasks. GitHub/Drive hold immutable or versioned source, approved prompts/skills, content, evidence and full artifacts; Linear points to them. The future runner state store holds execution IDs, retries, budgets, event offsets and permissions. No single tool replaces the others.

**Do not auto-create a Linear project for every asset or brainstorming message.** Coordinated multi-asset campaigns and ongoing engineering efforts warrant projects. A one-off may still produce source-linked versioned artifacts and an approval record; those do not require Linear. Existing free issue limits remain a runtime constraint until an upgraded plan is confirmed.

## New campaign project contract

On project creation, capture:
1. Outcome and target reader/business objective, channel(s), scope and exclusions.
2. Canonical **START HERE / Handoff Brief** link(s).
3. Source-of-truth project/repo/Drive context pointers, relevant branch or commit hash.
4. Story/angle plan and individual Linear issues per task; owners and present state.
5. Draft, brief, QA and review artifacts with versions, links and remaining blockers.
6. Exact approved decisions, unresolved questions, deferred related ideas, privacy and publish permissions.
7. Next recommended task and how an agent verifies that prior work is actually complete.

The Linear project must remain intelligible to a *new model with no memory of this chat*. Each task should link to a sufficiently small context packet, rather than requiring a model to reread many unrelated chats. Links alone are not permission to read private apps.

## End-of-chat capture (nuance-preserving)

**Future callable command:** `studio capture-session --source <authorized conversation/export> --project <id>`.  
Potential future event source: platform-specific authorized completion hook. Do **not** assume a generic Claude/ChatGPT conversation end event or full transcript API exists.

A source-mining specialist extracts:
- owner intent versus exploratory brainstorm versus explicit decision;
- the original question, reasoning, alternatives, why one idea was accepted/rejected;
- caveats, exceptions, tone/voice examples, edits and unresolved nuances;
- explicit author quotes or short permissioned excerpts, with exact source position;
- source-backed facts versus agent suggestions and hallucinated examples;
- cross-channel potential story angles, sensitivity level and what needs owner clearance;
- next concrete opportunity and related campaign/project.
It proposes a concise capture card for the owner to correct or approve before editorial public use.

**Reader quality example:** "It wasn't this, it was that" is an explicit owner writing complaint. Store the specific diagnosed pattern and negative fixture; do not transform it into a global prohibition against every contrast or redesign the architecture.

## Handoff packet (required for any model)

```yaml
handoff_version: "1.0"
campaign:
  linear_project: "<actual project URL>"
  tenant_workspace: "<authorized manifest URL>"
  objective: "<current outcome>"
  approved_strategy_version: "<URL + commit>"
source_context:
  source_list: ["<URI with visibility/authorization>"]
  conversation_sources: ["<authorized URI + timestamp/range>"]
  original_artifact_refs: ["<commit/branch/file>"]
decisions:
  approved: ["<decision + owner + time>"]
  proposals: ["<not yet approved>"]
  parked: ["<future ideas>"]
work:
  done: ["<item + evidence>"]
  in_progress: ["<item + exact version>"]
  blocked: ["<item + reason>"]
  next_task: "<single concrete action>"
quality:
  skill_versions: ["<skill identifier + SHA>"]
  checks: ["<pass/fail/unknown + source>"]
  known_failures: ["<unresolved>"]
approvals:
  draft_approved_version: null
  publish_permission: false
  external_account_access: []
runtime:
  last_run_id: "<optional persisted ID>"
  model_used: "<record actual model/provider>"
  model_calls_used: null
```

## Sync policy and failure handling

- Linear update and GitHub content update are separate actions; the future runner records both and reconciles missing updates after failure. Use idempotency keys and link back to the content commit.
- Treat Linear state as **work status**, not proof an artifact passed a factual review. Evidence must be available.
- Do not silently replace owner decisions by a new model's interpretation; log a proposed change and request approval on consequential contradictions.
- A project card or approved brief is not publication permission.
- Never store private raw transcripts, credentials or personal job-search metrics in a broadly visible Linear project. Use redacted summaries and secure links.
