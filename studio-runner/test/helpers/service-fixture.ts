import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/runner.ts";

/** A synthetic workspace template for Studio Service tests. */
export function sourceWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "studio-service-source-"));
  cpSync(join(REPO_ROOT, "studio-runner/fixtures/agent-sample"), dir, {
    recursive: true,
  });
  mkdirSync(join(dir, "docs"));
  writeFileSync(
    join(dir, "docs", "guide.md"),
    "# Guide\nSynthetic service context for the fictional tool library.",
  );
  writeFileSync(
    join(dir, "studio-business.json"),
    JSON.stringify({
      schema_version: "studio.business/0.1",
      workspace_id: "riverside-tool-library",
      allowed_roots: ["docs"],
      defaults: {
        audience: "volunteers",
        provider: "fixture",
        models: {},
        budget: {},
      },
      catalog: [
        {
          id: "guide",
          path: "docs/guide.md",
          visibility: "approved",
          description: "fictional",
        },
      ],
    }),
  );
  return dir;
}
