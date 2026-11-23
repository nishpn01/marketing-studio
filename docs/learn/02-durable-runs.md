# 2. Durable runs

A model call can fail in the middle of a run. The process can be killed, the network can drop, the machine can restart. The question this chapter answers is what survives, and why a resumed run does not start over.

## The store

Every run opens a SQLite database under the workspace's `.studio/` directory. The store is opened by `openWorkspace` in [`studio-runner/src/runner.ts`](../../studio-runner/src/runner.ts). The current schema has two tables:

- `runs`: one row per run, with its status, request, call count, and step count. `runs.steps` is a counter, not a progress log.
- `events`: an append-only list. Each step completion, model receipt, state change, and artifact write is a row. Resumable step state is represented by `step_complete` events.

There is no separate `steps` table. `record()` and `setState()` ([`runner.ts`](../../studio-runner/src/runner.ts:38)) write those rows. Nothing important lives only in memory. Evidence: [`runner.ts`](../../studio-runner/src/runner.ts:128-140).

## Receipts

Before the pipeline trusts a model result, it writes a receipt to disk. In `agent-run.ts` the receipt file is `${c.dir}/receipts/${key}.json` ([`agent-run.ts`](../../studio-runner/src/agent-run.ts:247)). The receipt records which step ran, which provider answered, whether it was live or fixture, and the usage numbers.

The order matters. The runner records the intent, calls the model, then writes the receipt. Two fault points make this testable:

```ts
if (process.env.STUDIO_FAULT_BEFORE_RECEIPT === key) { ... process.exit(75); }
if (process.env.STUDIO_FAULT_AFTER_RECEIPT === key) { ... process.exit(76); }
```

A crash before the receipt leaves no result. A crash after the receipt leaves a recorded result that must not be paid for twice. Resume handles both.

## Resume skips finished work

`resumeAgentRun` reads the events and only runs steps that are not already complete. The helper is small:

```ts
const has = (c: Ctx, step: string) => events(c.db, c.id, 'step_complete').some(e => e.step === step);
```

And `hasCompleted` in `runner.ts` does the same query for the simpler runner ([`runner.ts`](../../studio-runner/src/runner.ts:216)). A completed step is skipped, not repeated.

This is what idempotency means in this codebase. It does not promise that a provider bill appears exactly once in every possible crash window. If the process dies after the provider answered but before the receipt was written, that call may be billed and lost. The runner records the risk as `usage_unknown` and may retry it. What it can guarantee is that a recorded step is not executed again.

A recorded receipt prevents that model step from being invoked again when the receipt file and recorded digest agree. Artifact files are atomic and digest-checked on read; the local filesystem is not immutable. A user with filesystem access can edit files; the runner detects many edits when it rereads them.

Artifact writes go through `atomicWrite` ([`runner.ts`](../../studio-runner/src/runner.ts:177)): write a uniquely named temp file, then rename. A half-written draft never appears under the final name. A lock ([`runner.ts`](../../studio-runner/src/runner.ts:89)) stops two processes from writing the same workspace at once.

## Resume safety sequence

The sequence in `modelStep` ([`agent-run.ts`](../../studio-runner/src/agent-run.ts:229-265)) is:

1. `model_intent` event recorded with the step key, role, provider, requested model, and prompt digest.
2. Provider call.
3. Atomic receipt file written at `${run}/receipts/${key}.json`.
4. `model_receipt` event recorded, containing the SHA-256 of that receipt file.

On resume:

- If a `model_receipt` event exists and its digest matches the receipt file, the stored result is reused. No provider call.
- If an `model_intent` exists but no receipt, the runner records `usage_unknown` and may retry within budget.

This is duplicate-invocation control, not exactly-once billing. It bounds repeated calls; it does not promise a provider never billed twice across a crash. Evidence: [`agent-run.ts`](../../studio-runner/src/agent-run.ts:229-265).

## What resume looks like

The test suite uses the fixture process to kill a real run and resume it. I ran the same sequence while writing this:

```sh
cp -R studio-runner/fixtures/agent-sample /tmp/studio-learn-02
node -e "const f='/tmp/studio-learn-02/request.json';const j=require(f);j.provider='fixture';require('fs').writeFileSync(f,JSON.stringify(j,null,2))"

STUDIO_FAULT_AFTER_RECEIPT=writer_v001 \
  node --experimental-strip-types --no-warnings \
  studio-runner/test/helpers/fixture-run.ts start /tmp/studio-learn-02 /tmp/studio-learn-02/request.json
```

That exits with code 76 after the writer has been paid for. The run directory exists. Then:

```sh
run=$(ls /tmp/studio-learn-02/.studio/artifacts)
node --experimental-strip-types --no-warnings \
  studio-runner/test/helpers/fixture-run.ts resume /tmp/studio-learn-02 "$run"
```

The resumed run ends at `WAITING_FOR_OWNER`, and its `calls_by_role` is:

```json
["fact_reviewer","craft_reviewer"]
```

Two calls, not four. Director and writer were already done, so they did not run again. The draft was not re-billed and the version did not change.

## Why not just retry from the start

Retrying from scratch is simpler to write and worse to operate. It spends money twice, changes the draft under the owner, and loses the evidence that the first attempt happened. Recording events costs a few rows per run and makes the failure visible. That is the trade this codebase chose.

The remaining limit is honest: the runner is local, single-user, and the lock is per workspace. It is not a distributed scheduler. The events table is the seam where a real durable orchestrator would attach later, but nothing here claims that today.

Next: [trust and approvals](03-trust-and-approvals.md).
