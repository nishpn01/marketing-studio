# Local Runner — v0.7 infrastructure (draft-only)

**Status:** A shared local Runner executes the deterministic mock slice (`studio.request/0.1`) and model-backed Newsletter **or Conversion Copywriting** specialist route (`studio.request/0.2`) with persistent state, source handling, independent factual/craft QA and exact-version owner review. The local subscription adapters are `claude-code-cli` and `codex-cli`; fixture models support offline tests. The loopback Studio Service now provides signed authority, a passkey inbox and tenant-configured workers (fixture default), while the legacy CLI remains unauthenticated local state. Codex is a subscription provider, pending one owner live acceptance run. No publisher or Studio scheduler exists. Use trusted local synthetic/nonsensitive workspaces only. See [Getting Started](../docs/GETTING-STARTED.md), [Architecture](../docs/ARCHITECTURE.md) and [current authority status](../docs/operations/AUTHORITY-AND-CAPABILITY-STATUS.md).

The E4/E5/E6 sections below are historical development walkthroughs, not a complete current capability inventory.

## Purpose

Validate the first engineering boundaries in the [Runner Technical Design](../docs/engineering/ADR-001-runner-execution-stack.md): manually triggered local execution, limited source access, explicit draft-only permissions, persistent SQLite run/event state, actual invocation of the existing Python newsletter *metadata* gate, and recovery from an interrupted local draft write.

**The mock brief and article are clearly labeled simulation fixtures; never present them as approved content.** A string match against source text is not factual verification. The terminal state is `SIMULATION_COMPLETE`, intentionally distinct from `WAITING_FOR_OWNER` for a real independently reviewed asset.

## E4 agent pipeline (model-backed)

**v0.7 source boundary:** The Runner refuses ungranted restricted sources and constructs role-specific views for narrow source/version/session/host/purpose-bound excerpt grants. It revalidates those views at model-call boundaries. These grants are **unauthenticated local owner assertions** and local-writer bypasses VULN-1/VULN-7b remain. Never relabel a restricted source to evade the gate, and do not supply sensitive tenant data in v0.7. See [Scoped Disclosure](../docs/security/SCOPED-DISCLOSURE.md).

```sh
# Synthetic demo. Uses the local Claude Code login; refuses to run if ANTHROPIC_API_KEY is set.
cp -R studio-runner/fixtures/agent-sample /tmp/my-ws
node --experimental-strip-types studio-runner/src/cli.ts run --workspace /tmp/my-ws --request /tmp/my-ws/request.json
node --experimental-strip-types studio-runner/src/cli.ts revise --workspace /tmp/my-ws --run-id <id> --feedback notes.md
node --experimental-strip-types studio-runner/src/cli.ts resume --workspace /tmp/my-ws --run-id <id>
```

- **Request `studio.request/0.2`:** `idea`, `audience`, `source_paths`, optional `restricted_sources`, `provider` (`claude-code-cli` or `codex-cli`), a model for each role, and a budget (`max_model_calls`, `max_steps`, `max_revision_rounds`).
- **Capability packs:** `packs/newsletter` and `packs/conversion-copywriting` use the shared `text-asset` pipeline. A request without `pack_id` explicitly normalizes to `newsletter`; the older `specialist` field is accepted as an alias. Pack manifests declare prompts, role-scoped skills, model tiers, output schema, deterministic gates, QA rubric and budget defaults. The manifest, prompts, skills and rubric are pinned for resume. New packs can run without a Runner source change; conversion execution is verified with fictional fixtures, not a real business deployment.
- **Output:** `.studio/artifacts/<run>/`, containing:
  - `brief.json`;
  - immutable `draft-vNNN.md` versions;
  - `claim-manifest`, `metadata-gate`, `factual-qa` and `craft-qa` files for each version;
  - `receipts/` (one per model call);
  - `review-package.md` and `run-snapshot.json`.
- **Packs, roles and skills:** `../packs/<id>/pack.json`. Pack content is pinned per run, and any change blocks resume.
- **Live sample:** `examples/live-run-2026-11-11/`.

### Owner workflow (E5)

1. `run` creates a run. When it reaches `WAITING_FOR_OWNER`, read `review-package.md`, which lists every blocker with a stable ID.
2. `revise --feedback notes.md` produces a new immutable version and re-runs both reviews. Revising an approved run invalidates the approval.
3. `approve --digest <sha256> [--decisions decisions.json]` approves the exact current version. Every blocker needs an explicit, kind-appropriate decision (`{"schema_version":"studio.owner-decisions/0.1","decisions":{"claim:c3":{"decision":"owner_attests","reason":"..."}}}`). The approval is **unauthenticated** and **never authorizes publication**.
4. `cancel --reason "..."` ends a run permanently.
5. `handoff-check` (live reader), `handoff-prompt` and `handoff-score` test whether another session can reconstruct the run from `run-snapshot.json` and `review-package.md` alone.

Results: covered by the checked-in Runner tests.

### Workspace context overlay (E6)

A private workspace can add **`studio-context.json`** at its root, next to `studio-workspace.json` (template: `templates/workspace/studio-context.example.json`). It declares files under `context/` and the roles that receive each one.

- **Placement.** Each role gets only its scoped files, after Core's role prompt and skills.
- **Precedence.** The overlay text states that it can't change evidence rules, the output schema, privacy limits (it may add stricter ones), permissions or draft-only status.
- **Not evidence.** Facts in the overlay can't be cited as sources.
- **Flags.** Lines that look like out-of-scope instructions (publish now, ignore rules, approval flags, credentials, skipping review) are flagged in the package. They are never obeyed as permissions.
- **Pinning.** The config and file hashes are pinned for each run. Any change blocks resume, and a missing file blocks before any run is created.
- **Location.** The overlay is declared in the trusted workspace, never in the per-run request. Core ships no business context.

Results: covered by the checked-in Runner tests.

## Requirements and environment

- **Node 26** is the preferred runtime (`.node-version`); CI also tests **Node 22.16.0**. Built-in TypeScript stripping and `node:sqlite` are used without external npm dependencies.
- **Python 3.13** is the tested CI interpreter (`.python-version`) for the existing `tools.newsletter_gate` module.
- No npm dependencies, API credentials, paid model access or external network required for the mock slice.

**GitHub CI now runs the checked-out code on Node 22.16 and Node 26 with Python 3.13**, including the Python gate tests and expanded Runner tests. [Workflow](../.github/workflows/studio-runner-ci.yml). It does not yet run a security audit, Zod schema validator, or live provider adapter.

## Commands (from repository root)

```sh
node --experimental-strip-types studio-runner/src/cli.ts doctor

node --experimental-strip-types studio-runner/src/cli.ts run \
  --workspace studio-runner/fixtures/sample \
  --request studio-runner/fixtures/sample/request.json

node --experimental-strip-types studio-runner/src/cli.ts status \
  --workspace studio-runner/fixtures/sample

node --experimental-strip-types studio-runner/src/cli.ts inspect \
  --workspace studio-runner/fixtures/sample --run-id <run-id>

node --experimental-strip-types studio-runner/src/cli.ts resume \
  --workspace studio-runner/fixtures/sample --run-id <run-id>

node --experimental-strip-types --test studio-runner/test/*.test.ts
```

For local work, create a separate **private** workspace with `sources/`, a validated request JSON, and a root-local `studio-workspace.json` identity file (see sample fixture). The Runner requires the request's `workspace_id` to match this local owner-maintained identity. A trusted launcher can also set `STUDIO_ALLOWED_WORKSPACE_ROOT=/absolute/trusted/path` to pin the exact directory. **This is local configuration, not authenticated tenant isolation.** A future hosted/chat adapter must choose trusted roots independently of model input. State stays under `<workspace>/.studio/`. The mock Runner does **not** retrieve URLs, fetch Drive/GitHub, sync Linear or have any publisher tools.

Studio Service templates must use absolute (`${VAR}`) catalog roots; relative roots are not copied into tenant state.

## Safety controls included in this experiment

- Only `mock` provider; unknown providers fail closed.
- Only `read_sources`, `write_private_draft`, `run_metadata_gate`; requesting `publish`, `send`, `deploy` or `merge` blocks before provider execution.
- Source files must resolve within the workspace's `sources/` directory, with symlink traversal outside that directory refused.
- Runtime output-path symlinks are refused; local files are atomically renamed.
- Model-call and step limits are checked. The mock's "cost" is zero and is not a real API cost estimate.
- SQLite stores runs/events with transactional state and mock-call counter updates. An exclusive single-host `runner.lock` prevents simultaneous execution and permits stale-dead-PID cleanup after an abnormal exit. This is **not a distributed lease or authenticated lock**.
- Crash injection supports `STUDIO_FAULT_AFTER_BRIEF_WRITE=1`, `STUDIO_FAULT_AFTER_DRAFT_ONLY_WRITE=1` and `STUDIO_FAULT_AFTER_DRAFT_WRITE=1`. Resume reconciles deterministic mock artifacts without repeating a completed mock call. Completed runs verify persisted brief, draft, manifest, QA reports and package against recorded SHA-256 digests before reuse.
- SHA-256 source index invalidates a previously complete run if source contents change.
- Initial mode supports one-off asset requests without creating Linear projects. Campaign requests require an existing Linear project pointer, but synchronization is **not implemented**.

## Known limitations before live model execution

- Python gate is **metadata only**: a warning that an independent source check is needed is not a PASS. The mock additionally checks only literal source-text membership.
- No independently executed `/unslop`, human editorial reviewer, owner live acceptance of the Codex Service provider or paid API inference. The Service inbox provides passkey-gated exact-version private approval; the legacy CLI approval remains unauthenticated.
- The legacy `RunStore` is local and intended for one active process per workspace. The Service uses forked workers and loopback HTTP, but is not a cross-host lease, distributed fence, remote outbox, or same-OS-user security mechanism. It is loopback-only today; remote access is planned only through the approved remote-gateway design (see the [owner policy](../docs/operations/AUTHORITY-AND-CAPABILITY-STATUS.md#owner-policy-2026-11-14)).
- A process can be killed during a provider call in the future; local durability cannot guarantee one billable model call was never repeated.
- The Node 26 **runtime compatibility and checked-out CI smoke suite are verified on `main`**, with Node 22.16 and Python CI coverage. API provider adapters and external billing remain unimplemented; subscription-backed Service execution is tenant-configurable but Codex still awaits one owner live acceptance run. Do not promote this Service to production.

## Compatibility with older mock runs

Older local mock runs created before the manifest/digest hardening may not be resumable because their event records lack the new checksum fields. Keep the old artifact for inspection and start a fresh **mock** run; do not automatically migrate an untrusted draft or claim prior editorial approval.

## Extensibility

The public `Request`, source index, state/event and file-artifact conventions are an **early internal sketch**. Later adapters should implement the versioned `ModelPort`, `SourcePort`, `WorkerPort`, `RunStore` and `ArtifactPort` contracts documented in the ADR. The local CLI and any future authenticated hosted API should call the same execution service rather than embed prompt or publishing logic in the interface.

**Next:** review the checked-in Runner tests. This experiment demonstrates only a subset of Milestone A; it does not pass the full acceptance plan.
