# Optional: fictional demo (about 5 minutes)

Use this only to look around without touching a real workspace. It makes a throwaway fictional business in a temp folder. It calls no model and needs no login. Real setup is in [Getting started](GETTING-STARTED.md).

```sh
cd marketing-studio-core                      # your clone
export STUDIO_CORE="$PWD"
export STUDIO_DEMO="$(mktemp -d /tmp/studio-demo.XXXXXX)"
export STUDIO_WORKSPACE="$STUDIO_DEMO/workspace"
mkdir -p "$STUDIO_WORKSPACE/docs"

cat > "$STUDIO_WORKSPACE/studio-workspace.json" <<'JSON'
{ "schema_version": "studio.workspace/0.1", "workspace_id": "fictional-demo", "sources": [] }
JSON

cat > "$STUDIO_WORKSPACE/studio-business.json" <<'JSON'
{
  "schema_version": "studio.business/0.1",
  "workspace_id": "fictional-demo",
  "allowed_roots": ["docs"],
  "defaults": {
    "audience": "readers of a fictional product newsletter",
    "provider": "claude-code-cli",
    "models": { "director": "sonnet", "writer": "sonnet", "fact_reviewer": "sonnet", "craft_reviewer": "sonnet" },
    "budget": { "max_model_calls": 12, "max_steps": 40, "max_revision_rounds": 1 }
  },
  "catalog": [
    { "id": "fictional-brief", "path": "docs/fictional-brief.md", "visibility": "approved", "description": "Synthetic description" }
  ],
  "context_sync": []
}
JSON

cat > "$STUDIO_WORKSPACE/docs/fictional-brief.md" <<'MD2'
# Fictional Product Brief

Dayboard is a made-up local preview that shows a small personal task list.
No customers, usage numbers, revenue, launch or measured results exist.
MD2

"$STUDIO_CORE/studio-runner/bin/studio" session-start --workspace "$STUDIO_WORKSPACE" \
  --idea "Explore a newsletter idea for the fictional Dayboard preview." --slug first-idea
"$STUDIO_CORE/studio-runner/bin/studio" context-search --workspace "$STUDIO_WORKSPACE" --query "Dayboard preview"
"$STUDIO_CORE/studio-runner/bin/studio" session-status --workspace "$STUDIO_WORKSPACE"
```

Expected: the session `first-idea` is `discussing`, and the search finds the fictional brief. The CLI prints JSON. No model ran.

To try the host skills on the demo, use the install commands from [Getting started](GETTING-STARTED.md) with `$STUDIO_WORKSPACE` and a throwaway host folder.

Clean up with `rm -rf "$STUDIO_DEMO"`, but only after checking that `echo "$STUDIO_DEMO"` shows the temp folder you just made.
