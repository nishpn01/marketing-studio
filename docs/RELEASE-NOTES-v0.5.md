# Marketing Studio Core v0.5: release notes and merge plan (PRs #1–#9)

Historical release record. It predates the current `main`; use [Architecture](ARCHITECTURE.md), [Roadmap](ROADMAP.md), and [Build Log](BUILD-LOG.md) for current state.

**Status:** prepared for the owner's explicit integration decision. **Nothing has been merged.**

## What this release contains

| PR | Branch | What it adds | CI |
|---|---|---|---|
| #1 | `feature/newsletter-specialist-v1` | Architecture consolidation v1.0 draft, Director/specialist contracts, newsletter specialist and skills, Python metadata gate | n/a (pre-CI; tested by later PRs) |
| #2 | `studio-runner-technical-design` | Runner ADR, contracts v0.1, acceptance plan R01–R30 | n/a (docs) |
| #3 | `studio-runner-local-mvp` | Local mock Runner: SQLite runs/events, locks, crash/resume | n/a (the workflow arrives in #4) |
| #4 | `studio-runner-step1-hardening` | CI on Node 22.16 and 26, workspace trust, concurrency and crash integrity | pass |
| #5 | `studio-shared-quality-audit-v1` | Shared research/evidence and quality-gate contracts; safer metadata gate | pass |
| #6 | `studio-runner-e4-agent-pipeline` | Model-backed Director → newsletter → independent fact/craft QA → owner package (`claude-code-cli` adapter) | pass |
| #7 | `studio-runner-e5-owner-controls` | `approve`/`cancel`, blocker decisions, portable handoff check, pinned `tsc` in CI | pass |
| #8 | `studio-runner-e6-workspace-context` | Pinned, role-scoped workspace context overlay | pass |
| #9 | `studio-release-prep` | Release fixes (below) and these notes | see PR |

## Integration verification (2026-11-11)

- **The stack is linear.** Each PR's head is an ancestor of the next, and `main` (`5a45dbd`) is an ancestor of #1. `main` has not moved, so integrating is a fast-forward of 135 commits (119 files, +8,432/−20).
- **Clean checkout of #8's head:**
  - `npm --prefix studio-runner test`: 63/63 pass;
  - `python3 -m unittest`: 22 OK;
  - pinned strict `tsc`: clean.
- **Security sweep:**
  - no credential patterns found in tracked files;
  - every subprocess call uses an argument array with no shell;
  - `.studio/` is gitignored;
  - the adapter refuses to run when `ANTHROPIC_API_KEY` is set;
  - no publish, send or merge code path exists;
  - examples are synthetic and contain no personal data.
- **Tenant mentions:** an example tenant is named in 11 docs as the pilot tenant, as architecture context only, with no personal records. The repo is private. **Generalise these before Core is ever made public.**

## Release blockers fixed in #9

1. **CI did not run on pushes to `main`.** The push trigger listed only `studio-runner-step1-hardening`; `main` is added.
2. `doctor` reported "Node 26 compatibility remains unverified", which CI disproves. The note is corrected.

## Recommended merge sequence (owner action)

1. Merge **#1 → main** with **"Create a merge commit"**. **Do not squash.** Squashing rewrites history, and every PR above it would then show conflicts.
2. Retarget **#2** to `main` (GitHub does this automatically if the merged branch is deleted), wait for CI, and merge with a merge commit. Repeat the same way for **#3 → #9**, in order.
3. **Alternative (one step).** Retarget **#9** to `main` and merge it with a merge commit. GitHub then marks #1–#8 as merged, because their commits land on `main`. This is faster, but it skips the per-PR merge record.
4. After merging, confirm the workflow runs on `main`, and tag `v0.5.0`.

## Known limitations carried into v0.5

- **Local only.** One operator; the Claude Code CLI adapter only (subscription login, no API key). There is no hosted runner and no cross-provider adapter.
- **Approval is unauthenticated.** It's editorial only and never authorizes publication.
- **No publishing, scheduling, Linear sync or analytics.**
- **Reviewer independence** comes from separate invocations and inputs, not separate model families.

## Addendum (2026-11-11): status of #10 and #11, and the v0.6 plan

- **#10** `studio-director-conversational` (stacked on #9): conversational Director. CI is green on Node 22.16 and 26.
- **#11** `feature/copywriting-role-methods-v1` (stacked on #10, written separately with ChatGPT): copywriting methods, a conversion-copy specialist definition and routing tests. CI is green. **It's a parallel change, not part of v0.5 or v0.6.** It edits `studio-runner/roles/roles.json`, adding pinned skills to the same four roles. The v0.6 branches don't touch that file or any other #11 file.
- **v0.6 order:** after v0.5, merge #10, then the roadmap PR, the conversation-capture PR and the flaw-to-fix PR, each with a merge commit and in stack order. #11 can merge after #10 at any point. It's a separate review, and after it, runs paused across the merge must start fresh, because skill pins change.
- **Still deferred:** no tag until the owner authorizes integration. Then tag `v0.5.0` after #9, and `v0.6.0` after the v0.6 PRs.
