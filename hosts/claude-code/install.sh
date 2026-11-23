#!/bin/sh
# Install the Marketing Director skills into a Claude Code project's .claude dir.
# Usage: hosts/claude-code/install.sh <project>/.claude <business-name> <business-workspace-path>
#    or: hosts/claude-code/install.sh --user <business-name> <business-workspace-path>
# --user installs into ~/.claude/skills and registers the MCP server at user scope (`claude mcp add --scope user`),
# so every chat has the Studio. Both modes merge only their own entries and never write the token.
# Registers the Studio MCP server in <project>/.mcp.json. No token is written: Claude Code expands
# ${STUDIO_TOKEN} from the environment when it connects. The port is STUDIO_PORT at install time (default 8765).
set -eu
core="$(cd "$(dirname "$0")/../.." && pwd)"
user=0; [ "$1" = "--user" ] && { user=1; shift; set -- "$HOME/.claude" "$@"; }
skills="$1/skills"; name="$2"; ws="$(cd "$3" && pwd)"
[ -f "$ws/studio-business.json" ] || { echo "No studio-business.json in $ws" >&2; exit 1; }
mkdir -p "$skills/marketing-director" "$skills/marketing-director-cli" "$skills/studio-idea"
cp "$core/hosts/claude-code/studio-idea/SKILL.md" "$skills/studio-idea/SKILL.md"
cp "$core/hosts/claude-code/marketing-director/SKILL.md" "$skills/marketing-director/SKILL.md"
cp "$core/hosts/claude-code/marketing-director-cli/SKILL.md" "$skills/marketing-director-cli/SKILL.md"
target="$skills/marketing-director-cli"
# Merge into any existing config so installing business B keeps business A.
python3 - "$target/config.json" "$core/studio-runner/bin/studio" "$name" "$ws" <<'PY'
import json, os, sys
path, studio_bin, name, ws = sys.argv[1:]
data = json.load(open(path)) if os.path.exists(path) else {}
data["studio_bin"] = studio_bin
data.setdefault("workspaces", {})[name] = ws
open(path, "w").write(json.dumps(data, indent=2) + "\n")
PY
chmod 600 "$target/config.json"
python3 "$core/hosts/claude-code/permissions.py" "$1" "$core/studio-runner/bin/studio"
port="$(printf %d "${STUDIO_PORT:-8765}")"
if [ "$user" = 1 ]; then
  mcp="user scope"
  # Claude Code expands ${STUDIO_TOKEN} in user-scope headers at connect time (checked on 2.1.325), so only the reference is stored.
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove --scope user marketing-studio >/dev/null 2>&1 || true
    claude mcp add --scope user --transport http marketing-studio "http://127.0.0.1:$port/mcp" --header 'Authorization: Bearer ${STUDIO_TOKEN}' >/dev/null
  else
    echo "claude not found; register the MCP server later with:"
    echo "  claude mcp add --scope user --transport http marketing-studio http://127.0.0.1:$port/mcp --header 'Authorization: Bearer \${STUDIO_TOKEN}'"
  fi
else
  mcp="$(cd "$1/.." && pwd)/.mcp.json"
  python3 - "$mcp" "${STUDIO_PORT:-8765}" <<'PY'
import json, os, sys
path, port = sys.argv[1], int(sys.argv[2])
data = json.load(open(path)) if os.path.exists(path) else {}
url = "http://127.0.0.1:%d/mcp" % port
old = data.setdefault("mcpServers", {}).get("marketing-studio", {}).get("url")
if old and old != url:
    print("Warning: replacing the marketing-studio MCP entry (%s -> %s); one project connects to one Service" % (old, url), file=sys.stderr)
data["mcpServers"]["marketing-studio"] = {
    "type": "http",
    "url": url,
    "headers": {"Authorization": "Bearer ${STUDIO_TOKEN}"},
}
open(path, "w").write(json.dumps(data, indent=2) + "\n")
PY
fi
echo "Merged CLI permission rules into $1/settings.json (host UX guidance, not enforcement)"
echo "Installed marketing-director (Studio Service), marketing-director-cli and studio-idea skills into $skills"
echo "Registered the marketing-studio MCP server in $mcp"
[ "$user" = 1 ] && echo "Skills: /marketing-director, /marketing-director-cli, /studio-idea in any chat. Check with: claude mcp list"
echo "Start the Service with --port $port, then before launching claude run:"
echo '  export STUDIO_TOKEN="$(cat <token path printed by studio-service>)"'
