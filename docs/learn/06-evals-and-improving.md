# 6. Evals and improving

A test that passes without checking the thing you care about is worse than no test. It buys confidence you did not earn. This chapter is about the eval harness built to avoid that, and about the route from an owner's complaint to a tested change.

## Replay, not live calls

[`studio-runner/src/eval.ts`](../../studio-runner/src/eval.ts) runs a pack against recorded role responses. No model is called during a replay. Each eval case in `packs/newsletter/evals/` contains:

- a request,
- the source texts,
- recorded responses for each role,
- the system prompt hash for each role at recording time,
- the expected status, blockers, fact verdicts, and gate exit code.

The harness feeds those responses through the real pipeline. It executes the same validation, the same gates, and the same review checks a live run would. Only the model output is frozen. That is what makes the result deterministic without making it fictional.

A case can also be marked `live_only` with a reason. Those cases are reported as not run rather than quietly counted as passes. In the newsletter pack, the style case is live-only because the v0 runner has no skill-promotion action to test.

## Stale recordings

A recorded response only means something if the prompt that produced it is unchanged. Every case stores `recorded_system_sha256`. Before replay, the harness recomputes the current system prompt hash for each role and compares:

```ts
const staleRecordingRoles = (c, pack) =>
  ROLES.filter(role => c.recorded_system_sha256?.[role] !== hash(systemPromptForRole(role, pack)));
```

A mismatch produces `STALE_RECORDING` and fails the case. The recording is not silently reused against a prompt it was never recorded for. If you edit a prompt, you must re-record deliberately.

This is the guard against the most common vacuous test: the prompt changed, the fixture did not, and the old fixture keeps passing for the wrong reason.

## Baseline comparison

Run with `--baseline <git-ref-or-results-file>` and the report adds a diff:

- `regressions`: cases that passed before and fail now.
- `improvements`: the reverse.
- `stale_recordings`: cases whose prompt hash moved.
- `new_cases` and `missing_cases`.
- `fixture_expectations_changed` and `pack_pin_changed`.

The diff reports those changes. `fixture_expectations_changed` and `pack_pin_changed` are warnings and metadata; `runEval` only forces `pass: false` for regressions. Baseline metadata exposes changed expectations; it does not fail the run. Evidence: [`eval.ts`](../../studio-runner/src/eval.ts:384-397,422-451).

## What the newsletter cases cover

The fixtures are named for the failure they catch:

- `COUNT-01` checks a denominator, so a percentage cannot be invented from a smaller sample.
- `GATE-01` exercises the metadata gate.
- `NEGATIVE-01` covers a case that should not produce a clean draft.
- `PRIVACY-01` checks restricted content does not cross a role boundary.
- `QUOTE-01` checks exact claim quotes.
- `SCOPE-01` covers an out-of-scope request.
- `STORY-01` and `STORY-02` cover narrative structure.
- `STYLE-01` is the live-only policy case.

The checked-in fixtures encode named failure classes. The repository does not establish that every case came from a real draft.

## Vacuous tests and mutation checks

Stale prompt hashes catch prompt drift. They do not catch weak replay fixtures or expected outcomes that move together with the code. Baseline metadata exposes changed expectations; it does not fail the run.

A useful check is a deliberate mutation. Break one thing and confirm the eval fails:

- Edit a role prompt and rerun; expect `STALE_RECORDING`.
- Weaken a gate or reviewer isolation in code and rerun; expect the case that relied on it to fail.
- Change an expected blocker and rerun; expect the diff to show that expectation moved.

If a mutation does not fail, the test is not checking what it claims. The prompt-edit mutation is the one in "Try it yourself" below.

## Owner feedback, not self-editing

The eval harness decides whether a proposed change holds. It does not decide what to change. That comes from the learning loop in [`docs/LEARNING-LOOP.md`](../LEARNING-LOOP.md):

1. Capture raw evidence without claiming causality.
2. Classify the problem: factual, research, narrative, audience, preference, tool, or strategy.
3. Choose the smallest scope.
4. Propose the change on an isolated branch or skill version, with the old rule visible.
5. Run the regression pack plus the current example.
6. Promote only if the benefit exceeds regressions, with a rollback path.

[`studio-runner/src/improvement.ts`](../../studio-runner/src/improvement.ts) records that workflow. A proposal needs the owner's own words, at least one reference to the evidence, and a scope inferred from what the fix touches. Shared-method and runner-code proposals require a non-empty `tests_required` array. The current code does not validate that it contains a two-asset regression; that remains a protocol requirement. Evidence: [`improvement.ts`](../../studio-runner/src/improvement.ts:79-84). The system does not merge, publish, or widen its own permissions.

The point is that "the model says this is better" is not evidence. A recorded replay against a fixed baseline is.

## Try it yourself

On this branch, run the newsletter pack:

```sh
node --experimental-strip-types --no-warnings \
  studio-runner/src/cli.ts eval newsletter
```

You should see `totals: { cases: 11, replayed: 9, passed: 9, failed: 0, live_only: 2 }` and `pass: true`.

Now prove the staleness guard works. Make a small edit to a role prompt and run again:

```sh
printf '\n<!-- edit -->\n' >> packs/newsletter/prompts/writer.md
node --experimental-strip-types --no-warnings \
  studio-runner/src/cli.ts eval newsletter
```

The run now fails with `STALE_RECORDING` for the writer. The harness refused to score old recordings against a new prompt. Revert the edit and it passes again.

That is the check in one command: a change is accepted when the recorded behavior still holds, or when a deliberate re-recording shows the change you intended.
