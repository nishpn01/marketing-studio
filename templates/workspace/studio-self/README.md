# Template: the Studio about itself

A ready first series for the owner: newsletters about how Marketing Studio Core is built. Every approved source is a public doc in your own clone of this repo. **No private data is used.**

Files:

- `studio-workspace.json`: the workspace identity (`studio-self`).
- `studio-business.json`: the audience, default models, budget and the four approved sources (`README.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md`; the dated `BUILD-LOG.md` is left out so a series cannot cite it as current evidence).

Copy it out of the clone and point it at your clone (one line to change):

```sh
export STUDIO_CORE="$HOME/marketing-studio-core"          # your clone
export STUDIO_WORKSPACE="$HOME/studio-workspaces/studio-self"
mkdir -p "$STUDIO_WORKSPACE"
cp "$STUDIO_CORE/templates/workspace/studio-self/studio-workspace.json" "$STUDIO_WORKSPACE/"
sed "s#/ABSOLUTE/PATH/TO/marketing-studio-core#$STUDIO_CORE#" \
  "$STUDIO_CORE/templates/workspace/studio-self/studio-business.json" > "$STUDIO_WORKSPACE/studio-business.json"
"$STUDIO_CORE/studio-runner/bin/studio" context-search --workspace "$STUDIO_WORKSPACE" --query roadmap
```

You should see results from `roadmap` and `readme`. If the path is wrong, the command says a catalog source is not available.

Notes:

- The audience line and `provider` are defaults. Edit them before the first Service start. The Service copies this folder once at first start.
- `studio-context.json` and `context/style-guide.md` set the default style (no em dashes, sentence-case headings, no motivational close). Edit that file to change it. A workspace with no style context at all gets the same three rules from code (`studio-runner/src/workspace-context.ts`). Add other sources as extra `catalog` entries and keep private notes `restricted`.
- The sources are your clone's current files. When you pull new commits, the next run sees them.
- Full walkthrough: [Getting started](../../../docs/GETTING-STARTED.md).
