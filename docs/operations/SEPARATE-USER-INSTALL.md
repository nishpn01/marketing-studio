# Separate-user install (the tracked authority milestone)

**Status: script and tests exist; the live install has NOT been run on the owner's machine.** Unit tests mock the OS and simulate ownership; a `--dry-run` was reviewed. Do not call the Service "ready for private data" until you have run the steps below and `verify` passes.

## What it does

The Studio Service runs as a launchd **daemon under a hidden service user** (`_studio`). The owner's login user cannot write the authority store, signing keys, SQLite database, job state or the code that runs as the daemon. This closes the "same-OS-user process can replace or roll back the authority store" residual in [Trust boundary](../ARCHITECTURE.md#trust-boundary) against anything running as the owner (a compromised tool, a prompt-injected host, a future gateway).

```text
/Library/MarketingStudio/            root:wheel 755   (owner cannot rename or replace what is below)
  code/                              root:wheel       fresh git clone of one reviewed commit; the daemon runs THIS, not your checkout
  data/                              _studio 0700     --data-root: tenants/<id>/{authority sqlite, key, jobs, workspace, tenant.json, token}
  home/                              _studio 0700     HOME of the daemon: its model-CLI login
  public/                            _studio 755      token (read-only copy) and service.log, each readable only by you via an ACL
/Library/LaunchDaemons/com.marketing-studio.service.plist   root:wheel 644
```

The future token store, audit log and connection records of the remote gateway live under `data/tenants/<id>/`, so they inherit this ownership.

## Install

Creating the OS user is an owner action. The script never runs anything unless **you** run it as root, and `--dry-run` prints every command first.

**The installer runs as root, from files your login user can write.** `studio-runner/bin/studio-install`, `separate-user-install.ts` and the `node` on your `PATH` (Homebrew and nvm are owner-writable) all execute as root under `sudo`. Anything already running as you could edit them before your next `sudo`, so running it straight from your checkout only protects you against a mistake, not against that code. Two controls reduce this, and a third removes it:

- **Pin the commit.** The dry-run prints the full 40-character sha it would install. The real run refuses unless you pass `--commit <that sha>`. It fetches that sha and checks that the fetched commit is exactly it, so moving `HEAD` after your dry-run changes nothing (and a `--commit` that the source does not have fails the fetch). The dry-run is the only place the source is asked for its `HEAD` (`git ls-remote`), and not when run as root.
- **Scrubbed git.** Every git step runs with `env -i`, `HOME=/var/empty`, no system or global git config, `core.hooksPath=/dev/null`, `core.fsmonitor=false` and `git init --template=`, so your git config, repo-local hooks and fsmonitor cannot execute as root or leave a hook in the installed clone. Submodules are never recursed into. The installer runs **no git command inside your checkout at all** (no `status`, `rev-parse` or `config`, which read config reached through `include`, `includeIf`, worktree config and submodules and can run filter drivers): your checkout is only a remote, fetched by sha into a fresh root-owned repository, so its working-tree state is irrelevant. Git's own ownership check is left on.
- **Run the installer from a root-owned copy of the reviewed commit, with the official root-owned `node`.** Then nothing the owner can write is executed as root, and `--self-check` is a guard against mistakes (running it from your own checkout or an owner-writable `node` by accident). It is not a defence against code already running as you: it runs inside the installer after the installer's modules are loaded, so tampered files can skip it. The root-owned copy is the protection:

```sh
SHA=$(git -C <your checkout> rev-parse HEAD)                       # the commit you reviewed
sudo install -d -m 0755 -o root -g wheel /opt/studio-install-src
git -C <your checkout> archive "$SHA" | sudo tar -x -C /opt/studio-install-src
sudo chown -R root:wheel /opt/studio-install-src && sudo chmod -R go-w /opt/studio-install-src
sudo /usr/local/bin/node --experimental-strip-types --no-warnings /opt/studio-install-src/studio-runner/src/separate-user-install.ts \
  install --self-check --commit "$SHA" --source <your checkout> --node /usr/local/bin/node --provider claude-code-cli
```

The quick form, for a first look (always run the dry-run before the real run):

```sh
cd <your marketing-studio-core checkout>        # on the committed branch you reviewed
studio-runner/bin/studio-install install --dry-run --node /usr/local/bin/node --provider claude-code-cli   # prints "Reviewed commit: <sha>"
sudo studio-runner/bin/studio-install install --commit <sha> --node /usr/local/bin/node --provider claude-code-cli
```

Options: `--owner NAME` (default `$SUDO_USER`), `--provider fixture|claude-code-cli|codex-cli` (default `fixture`; fixed at first start, see below), `--port N` (default 8765), `--tenant ID` (default `studio-self`), `--user _name`, `--base DIR` (only under `/Library/` or `/opt/`), `--label NAME`, `--commit SHA` (required for a real install), `--self-check`. Re-running is safe: it re-creates only what is missing, repairs a half-created service user, replaces the code clone and restarts the daemon. To pick up a new commit, check it out, commit, review the new dry-run and re-run with its sha.

Refusals you may hit, by design:

- **A source that is not a git repository, or a `--commit` it does not contain.** The daemon runs a pinned clone of one commit; uncommitted changes in your checkout are not installed and are not looked at.
- **`node` that a non-root user can write**, by mode bits or by an ACL (for example a `group:admin allow write` entry). The daemon executes `node` as `_studio`, so an owner-writable `node` (or ancestor directory) would let the owner run code as `_studio`. Homebrew and nvm Node fail this (`/opt/homebrew` is owned by the admin user and links owner-owned dylibs). Install the official package from nodejs.org (puts `node` in a root-owned `/usr/local/bin`) and pass `--node`.
- **A service user that already exists but is not ours** (its `RealName` is not "Marketing Studio Service") or is in the `admin` group. An existing account of ours is checked attribute by attribute (shell, home, locked password, hidden) and any that are missing are set again.
- **A daemon that is loaded and will not stop.** The install stops before it swaps the code.

## After install: three owner steps

1. **Owner passkey (Touch ID).** Open `http://localhost:8765/inbox/setup`. The one-time code is printed in the service log; read it with `cat /Library/MarketingStudio/public/service.log` (ACL: only you and `_studio` can). For a fresh code: `sudo launchctl kickstart -k system/com.marketing-studio.service`. The inbox needs nothing else: it is the same `localhost` origin, and WebAuthn happens in your browser with your Touch ID.
2. **Token (read-only).** `export STUDIO_TOKEN="$(cat /Library/MarketingStudio/public/token)"`. It is a copy refreshed at every daemon start; you can read it but not edit it, and the authority store is not reachable from it.
3. **Model login** (only for `claude-code-cli` or `codex-cli`; see the decision below).

## Decision: how the daemon reaches your model subscription

The Service's live providers shell out to a CLI that holds a subscription login. A separate OS user does not see **your** login (it lives in your home or your Keychain), and must not, so each option below was evaluated:

| Option | Security | Usability |
| --- | --- | --- |
| **A. Log the CLI in once as `_studio` (recommended, implemented)** | No new code or channel. The credential sits in `home/`, unreadable by you and by anything running as you. The worker already runs `claude -p --tools ''` (no tools), so a prompt-injected job can only emit text. Residual: whoever gets code execution as `_studio` can use that login. | One extra step, once. Same subscription, no API key, no cost change. Your own CLI login is untouched. |
| B. Owner-side model helper on a local socket | Puts a process that runs under **your** login in reach of `_studio`-controlled input. It can be made narrow (fixed flags, no tools, size caps), but every flag is then security-critical and the socket path becomes a new boundary. More code to write and defend. | Best (no second login). A LaunchAgent in your session. |
| C. Fixture-only under the daemon | Strongest. | No live drafts through the Service; the CLI keeps the live route. |

A was chosen: smallest attack surface and no new trust channel, at the price of a one-time login. B is the fallback if A proves unworkable (below) and should get its own review. C is `--provider fixture`, the default.

**A: steps and what is NOT verified.**

```sh
# the CLI must live where _studio, not you, controls it; install it as _studio:
sudo -u _studio -H sh -c 'cd; <your official install command for the Claude Code CLI>'   # lands in /Library/MarketingStudio/home/.local/bin, which is on the daemon PATH
sudo -u _studio -H claude auth login          # follow the printed URL in your browser
sudo -u _studio -H claude auth status --json  # must say authMethod claude.ai, apiProvider firstParty
```

For Codex, run `sudo -u _studio -H codex login` instead. **NOT RUN:** whether the macOS Claude Code login persists for a hidden user with no GUI session and no login Keychain is unverified. If it does not, the Service reports `claude-code-cli did not report a first-party claude.ai login; refusing model invocation` and jobs fail closed. Then either use option B or stay on fixtures. The provider is stored in `tenant.json` at first start; to change it, use a new `--tenant` (old state stays) or purge and reinstall.

## Verify, as the owner

```sh
studio-runner/bin/studio-install verify
```

Run as your login user (it refuses root). It reports `ok`/`FAIL` for: every directory exists (a missing one is a FAIL, so an uninstalled machine fails); no write and no file creation in the state root, `code/`, `data/` (the authority store, keys and database inside it), `home/` and `public/`; **you cannot read or list `data/` and `home/`** (mode 0700); every file under `code/`, recursively, is root-owned and not group/world-writable; the launchd plist is not writable and names `_studio` as `UserName`; the `node` named in the plist and every ancestor of it is root-owned and not writable by you; `launchctl print system/<label>` shows the job loaded and not running as another user; no ancestor of the state root or of the plist directory (e.g. `/Library`, `/Library/LaunchDaemons`) is writable, since a writable ancestor could be renamed and replaced; the token copy is readable by you, **not empty** and not writable; the log is not writable. Exit code 1 on any FAIL. Re-run after OS upgrades or any manual `chmod`. **NOT RUN live:** whether `launchctl print` works for a non-root user on your macOS version; if it prints a FAIL for that line, confirm the daemon user with `ps -axo user,command | grep studio-service` instead.

Manual spot check of the acceptance criterion: `touch /Library/MarketingStudio/data/x` and `rm -rf /Library/MarketingStudio/data/tenants` must both say "Permission denied".

## Uninstall

```sh
sudo studio-runner/bin/studio-install uninstall --dry-run
sudo studio-runner/bin/studio-install uninstall            # keeps data/, home/ (model login), and the user
sudo studio-runner/bin/studio-install uninstall --purge    # deletes all of that and the user: authority history is gone
```

Uninstall only acts under a `--base` that carries the install marker (`.marketing-studio-install`, written by the install for this `--user`) and only deletes a service user whose `RealName` and home directory are ours, so a wrong `--base`, `--user` or `--label` is refused instead of deleting something else.

## Residual risk (state this honestly)

- **Anyone with admin/root can still do everything.** Your macOS account is almost certainly an admin: `sudo` (with your password) can read, replace or roll back the authority store, change the plist or the code clone, or `su` to `_studio`. A malware that obtains admin (a sudo password prompt, a privileged helper, a kernel bug) defeats this. This boundary protects against **non-admin same-user code**, not against the machine's administrator.
- **A process running as you can still *ask* for authority** through paths it legitimately has: the loopback MCP with the token (pending requests only, no approvals), and your browser session. Approvals still need the Touch ID passkey assertion bound to the shown request.
- **Token theft.** The token is readable by you, so code running as you can call the MCP. The MCP cannot write authority, approve, publish, spend or alter accounts.
- **Setup-code window.** Until the first passkey is registered, anything that can read your `service.log` (you; admin) and reach `localhost:8765` can register a passkey. Register it immediately after install.
- **Code swap on update.** Updating re-clones from your checkout; whatever you commit and install runs as `_studio`. Review before you install, and pin the reviewed sha with `--commit`.
- **The installer itself runs as root from owner-writable files** unless you use the root-owned copy above (see Install). Without it, code already running as you can change the installer or `node` before your next `sudo`; `--commit` and the scrubbed git steps narrow, but do not remove, that. This is the most important line in this list.
- **A virtual authenticator needs no Touch ID.** During the setup-code window, a process running as you that has read the code can register a software passkey with a virtual WebAuthn authenticator; the passkey ceremony does not prove a person was present until the first passkey exists. Register yours immediately after install.
- **`verify` cannot prove the running process's uid** on its own; it checks the plist, the `launchctl` output and the files. See the `ps` check above.
- **The owner cannot add business sources to the tenant workspace without `sudo`.** The first start copies `templates/workspace/studio-self` into `data/`, which only `_studio` can write, so the Service is usable for the self-workspace but not yet for your own company sources. Changing that needs a deliberate, reviewed channel (for example a root-run import of a reviewed folder); it is not built.
- **Rollback before restart** needs root or `_studio`; it is no longer reachable from your login. Backups of `data/` should themselves be root- or `_studio`-owned.
- **`_studio` compromise** (e.g. a Service bug) holds the model login and the authority store. This install limits blast radius to the Service; it does not make the Service bug-free.
- The log (`service.log`) grows without rotation; delete it as root occasionally.
- Local-only: the daemon still binds `127.0.0.1` and is never tunneled directly; only the approved remote-gateway design may be. A remote gateway ([report](../ROADMAP.md)) would run under its own low-privilege user and talk to the Service over loopback with a scoped token.
