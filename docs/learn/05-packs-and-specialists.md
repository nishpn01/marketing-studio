# 5. Packs and specialists

A specialist is a pack: a folder of data that tells the same runner which prompts to use, what output shape to expect, which checks to run, and how to evaluate the result. The runner is shared. The pack is the specialty.

The newsletter and conversion-copywriting specialists are the two working examples. Their manifests live at [`packs/newsletter/pack.json`](../../packs/newsletter/pack.json) and `packs/conversion-copywriting/pack.json`.

## What a pack declares

A pack manifest has a fixed shape. [`studio-runner/src/pack-loader.ts`](../../studio-runner/src/pack-loader.ts) rejects anything else.

- `schema_version`: `studio.capability-pack/0.1`.
- `id` and semver `version`, matching the directory name.
- `pipeline`: currently only `text-asset`.
- `roles`: prompt path, skill paths, and model tier for `director`, `writer`, `fact_reviewer`, `craft_reviewer`.
- `output_schema`: a small JSON Schema subset for the writer's result.
- `gates`: minimum draft words, whether claim quotes must be exact, whether claims need sources.
- `qa_rubric`: the file the craft reviewer works against.
- `budget_defaults`: model calls, steps, revision rounds.

The loader is strict on purpose. Unknown fields fail. Prompt paths are checked inside the packs root, not necessarily the individual pack directory. A skill path is allowed from the pack or from the shared repo, but not from anywhere on disk unless `STUDIO_ALLOW_OUTSIDE_ROLE_PATHS=1` is set. That variable is an explicit trusted-launcher or test override, not test-only. Evidence on this branch: [`pack-loader.ts`](../../studio-runner/src/pack-loader.ts:112-130).

## The shared reviewer is not configurable

One detail carries most of the trust. The `fact_reviewer` role is loader-owned:

```ts
const SHARED_FACT_PROMPT = '../shared/fact-reviewer.md';
```

A pack manifest must declare that exact prompt, the shared quality skill, and the `review` tier. If it declares anything else, the loader fails. A pack author can write the Director's strategy prompt and the Writer's voice prompt. They cannot replace the independent fact check with a friendlier one.

This is the same separation from chapter 1, enforced at load time rather than left to convention.

## What the schema and gates catch

`output_schema` is validated when the writer answers. The newsletter schema requires `title`, `draft_markdown`, `claims`, and `notes_for_owner`. Each claim requires an id, text, an exact draft quote, and at least one source id. A draft that returns prose without a claims manifest does not pass.

The gates are separate checks:

- `min_draft_words` catches a stub.
- `claim_quotes_exact` requires the quote to appear in the draft.
- `claims_require_sources` requires every claim to cite a source the run actually loaded.

These are mechanical. They do not judge writing quality. The craft reviewer and the rubric do that.

## Adding a specialist

The sequence that worked for newsletter and copywriting:

1. **Write research notes first.** Decide the reader, the job, and the failure modes. Keep raw notes in the business workspace, not in Core.
2. **Create `packs/<id>/` with a `pack.json` manifest.** Copy the shape from `packs/newsletter/pack.json`; set `id`, semver `version`, `roles`, `output_schema`, `gates`, `qa_rubric`, and `budget_defaults`.
3. **Write role prompts under `packs/<id>/prompts/`.** Director decides direction, Writer produces, craft reviewer applies the rubric. Keep each role's job narrow. The `fact_reviewer` prompt stays `../shared/fact-reviewer.md`; the loader rejects any override.
4. **Add skills and a rubric.** Skill paths can be pack-relative or shared repo paths.
5. **Define the output schema.** Start from real good output and remove anything the runner does not need. Require claims if factual accuracy matters.
6. **Choose gates.** Mechanical checks that fail closed. Prefer a few strict gates over many soft ones.
7. **Select the pack in a request.** Set `pack_id` in the request or direction approval; the runner loads it through `loadPack`.
8. **Write eval fixtures.** One case per behavior: a clean pass, a missing source, a scope violation, a privacy leak. This is chapter 6.
9. **Pin and test.** Run `node --experimental-strip-types --no-warnings studio-runner/src/cli.ts eval <id>`; the first run establishes the baseline.

The manifest is the contract. If the specialist needs a new pipeline shape rather than new prompts and gates, it is not a pack yet. Do not stretch `text-asset` into something it is not.

## Try it yourself

On this branch, load a pack and print what it declares:

```sh
node --experimental-strip-types --no-warnings --input-type=module -e "
import { loadPack } from './studio-runner/src/pack-loader.ts';
const p = loadPack('newsletter');
console.log(p.id, p.version, Object.keys(p.roles).join(','));
console.log(p.gates);
console.log(p.budget_defaults);
"
```

Output:

```text
newsletter 0.1.0 director,writer,fact_reviewer,craft_reviewer
{ min_draft_words: 80, claim_quotes_exact: true, claims_require_sources: true }
{ max_model_calls: 12, max_steps: 40, max_revision_rounds: 1 }
```

Then open `packs/newsletter/pack.json` and find each value in the output. The loader did not invent defaults. It validated the manifest and handed it to the runner.

Next: [evals and improving](06-evals-and-improving.md).
