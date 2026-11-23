#!/bin/sh
# sh hosts/codex/install.sh <target-project-dir> <business-name> <authorized-business-workspace-dir>
set -eu
[ "$#" -eq 3 ] || { echo "Usage: $0 <target-project-dir> <business-name> <workspace-dir>" >&2; exit 2; }
core="$(cd "$(dirname "$0")/../.." && pwd -P)"
target="$(cd "$1" && pwd -P)"
name="$2"
workspace="$(cd "$3" && pwd -P)"
[ -f "$core/AGENTS.md" ] && [ -f "$core/studio-runner/bin/studio" ] || { echo "Missing Core Runner" >&2; exit 1; }
[ -f "$workspace/studio-business.json" ] || { echo "Workspace not authorized/configured" >&2; exit 1; }
case "$name" in ""|*[!a-zA-Z0-9_-]*) echo "Invalid business name" >&2; exit 2;; esac
skills="$target/.agents/skills"
mkdir -p "$skills/marketing-director" "$skills/marketing-director-cli"
cp "$core/.agents/skills/marketing-director/SKILL.md" "$skills/marketing-director/SKILL.md"
dest="$skills/marketing-director-cli"
cp "$core/.agents/skills/marketing-director-cli/SKILL.md" "$dest/SKILL.md"
python3 - "$core" "$workspace" "$name" "$dest/config.json" <<'PY'
import json,sys
from pathlib import Path
core,ws,name,target=sys.argv[1:]
path=Path(target)
data=json.loads(path.read_text(encoding='utf8')) if path.exists() else {}  # merge so installing business B keeps business A
data.update({'core_root':core,'studio_bin':str(Path(core)/'studio-runner/bin/studio')})
data.setdefault('workspaces',{})[name]=ws
path.write_text(json.dumps(data,indent=2)+'\n',encoding='utf8')
PY
chmod 600 "$dest/config.json"
mkdir -p "$target/.codex/rules"
sed "s|__STUDIO_BIN__|$core/studio-runner/bin/studio|" "$core/hosts/codex/marketing-studio.rules" > "$target/.codex/rules/marketing-studio.rules"
# Codex reads MCP servers only from $CODEX_HOME/config.toml, so register through its CLI.
# `codex mcp add` replaces only this entry; the token comes from STUDIO_TOKEN at runtime.
url="http://127.0.0.1:$(printf %d "${STUDIO_PORT:-8765}")/mcp"
echo "Installed Codex marketing-director (Studio Service) and marketing-director-cli skills."
if command -v codex >/dev/null 2>&1; then
  codex mcp add marketing-studio --url "$url" --bearer-token-env-var STUDIO_TOKEN >/dev/null
  echo "Registered the marketing-studio MCP server with codex (\$CODEX_HOME/config.toml)."
else
  echo "codex not found; register the MCP server with:"
  echo "  codex mcp add marketing-studio --url $url --bearer-token-env-var STUDIO_TOKEN"
fi
echo "Start the Service with --port ${STUDIO_PORT:-8765}, then before launching codex run:"
echo '  export STUDIO_TOKEN="$(cat <token path printed by studio-service>)"'
