import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onboardWorkspace } from "../src/onboarding.ts";

test("onboarding records business context and pending source references without importing", async () => {
  const root = mkdtempSync(join(tmpdir(), "studio-onboarding-"));
  try {
    const answers = join(root, "answers.json");
    const workspace = join(root, "workspace");
    writeFileSync(answers, JSON.stringify({
      company: "Northwind Labs",
      product: "A local planning tool for small teams.",
      audience: "Operators who need a clear next step.",
      voice: "Plainspoken, specific, and candid about uncertainty.",
      goals: "Learn which reader question deserves the next issue.",
      sources: ["https://example.org/product", "notes/product-brief.md"],
    }));
    const result = await onboardWorkspace(workspace, answers);
    assert.equal(result.workspace_id, "northwind-labs");
    assert.equal(result.source_references, 2);
    assert.equal(result.imports_performed, false);
    const business = JSON.parse(readFileSync(join(workspace, "studio-business.json"), "utf8"));
    assert.equal(business.defaults.provider, "fixture");
    assert.deepEqual(business.onboarding.source_references, ["https://example.org/product", "notes/product-brief.md"]);
    assert.equal(business.catalog.length, 0);
    const context = JSON.parse(readFileSync(join(workspace, "studio-context.json"), "utf8"));
    assert.equal(context.files[0].path, "context/onboarding-profile.md");
    const profile = readFileSync(join(workspace, "context/onboarding-profile.md"), "utf8");
    assert.match(profile, /Northwind Labs/);
    assert.match(profile, /Source references to connect later/);
    assert.match(profile, /notes\/product-brief\.md/);
    assert.equal(readFileSync(join(workspace, "studio-workspace.json"), "utf8").includes("https://example.org/product"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("onboarding refuses to overwrite an existing workspace without explicit force", async () => {
  const root = mkdtempSync(join(tmpdir(), "studio-onboarding-existing-"));
  try {
    const workspace = join(root, "workspace");
    const answers = join(root, "answers.json");
    writeFileSync(join(root, "placeholder"), "x");
    writeFileSync(answers, JSON.stringify({ company: "Acme Example", product: "Tool", audience: "Readers", voice: "Clear", goals: "Learn", sources: [] }));
    await onboardWorkspace(workspace, answers);
    await assert.rejects(() => onboardWorkspace(workspace, answers), /already has config/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
