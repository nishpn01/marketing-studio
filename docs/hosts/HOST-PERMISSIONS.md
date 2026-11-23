# Host permission configuration (UX guidance, not enforcement)

`hosts/claude-code/install.sh` merges rules into the target project's `.claude/settings.json` (never `~/.claude`). `hosts/codex/install.sh` writes `.codex/rules/marketing-studio.rules` into the target project.

**What this is.** A prompt-before-authority layer so a well-behaved agent cannot run an owner-authority command without the host asking the human. **What this is not.** Cryptographic or OS-enforced security. An agent with arbitrary shell can bypass pattern rules (`sh -c`, `node`, a different or copied binary path, editing `.studio` files directly, env changes). The Studio's own approvals and grants are unauthenticated local text: anything that can write the workspace can forge them. The rules also do not stop a human-confirmed agent from composing the owner quote, so the SKILL.md requires the owner's own words.

## Claude Code
- `permissions.ask`: `Bash(*studio* <subcommand>*)` for every authority or model-spending subcommand (`source-disclosure-grant/revoke`, `capture-disclosure-grant/revoke/read`, `capture-import`, `capture-annotate`, `direction-approve`, `approve`, `improvement-decide`, `improvement-propose`, `session-run`, `session-rerun`, `run`, `resume`, `revise`, `cancel`, `handoff-check`, `eval`, `onboard`), plus `Bash(*--allow-dirty-pins*)`, `--owner-quote`, `--visibility`, `--authorization` anywhere.
- `permissions.allow`: only the installed studio binary (quoted and unquoted path) with read-only or discussion subcommands. Everything else falls to the default prompt.
- Headless (`claude -p`) has no approver, so ask and unmatched commands are denied. Interactive sessions prompt the owner.
- **Trust prerequisite.** Claude Code ignores project `permissions.allow` entries until the owner accepts the workspace trust dialog once (interactively). Ask rules still apply. Without trust, even read-only commands prompt.
- Rules were verified in real `claude -p` runs; see `docs/operations/HOST-ACCEPTANCE.md`.

## Codex
- Supported mechanism: execpolicy `prefix_rule(pattern=[studio_bin, subcommand], decision="prompt"|"allow")`, checkable offline with `codex execpolicy check --rules <file> -- <command...>`. Execpolicy matches command-token prefixes only, so it cannot see flags (`--owner-quote`, `--allow-dirty-pins`); `evidence-add` therefore always prompts.
- Loading of project-level `.codex/rules` by a live Codex session is **not verified** (Codex login was unavailable). The user-level `$CODEX_HOME/rules/` location is the documented place; the installer does not touch it. Copy the file there manually if you want it active, after review.
- Approval policy `never` (as `codex exec` showed) turns a `prompt` decision into a refusal; interactive approval policies ask.
