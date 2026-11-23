# Codex Marketing Director — local host entrypoint

**Implemented:** a host-native skill, installer and subscription-backed `codex-cli` ModelPort. **Not yet proven:** an actual fresh Codex session running it or one owner live acceptance run. The Service defaults to fixtures and selects a live provider only from tenant configuration.

From the Core checkout on the owner's Mac:

    sh hosts/codex/install.sh "<target project folder>" my-business "<authorized business workspace studio directory>"

The installer adds two skills. Use `marketing-director-cli` (the `studio` CLI) for the broader workflow today. `marketing-director` is the generated Studio Service MCP shim: it can start sessions and add approved catalog evidence; approvals go through the Studio Inbox, and production uses the tenant-configured provider with fixtures as the default. It still cannot cancel, ingest host evidence or run session-based revise. The installer also registers a `marketing-studio` MCP server with `codex mcp add` (written to `$CODEX_HOME/config.toml`, other entries kept; it prints the command if `codex` is not on PATH). The token is read from `STUDIO_TOKEN` at runtime; no token is written to disk.

Then open Codex desktop or CLI in the target project and say: **"Marketing Director, continue the newsletter."**

The CLI skill should use its locally installed config.json to discover the real business workspace, inspect session-status and improvement-list, and report the latest local version and unresolved owner decisions before any model call. Test a genuinely fresh Codex chat without supplying expected answers.

No local private data or credentials are committed by this adapter. Installed config.json contains sensitive local paths and must remain untracked. Codex Cloud cannot see a local-only .studio run or Claude subscription login without a deliberate, permissioned setup. Existing saved chats do not transfer automatically.

The installer also writes `.codex/rules/marketing-studio.rules` (execpolicy prompt rules for authority commands). Its live loading is unverified; see docs/hosts/HOST-PERMISSIONS.md and docs/operations/HOST-ACCEPTANCE.md. This is host UX guidance, not enforcement.
