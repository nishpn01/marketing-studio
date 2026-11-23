import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { REPO_ROOT } from "../src/runner.ts";
import { AuthorityStore, ServiceAuthorityProvider } from "../src/service/authority-store.ts";
import { StudioService } from "../src/service/studio-service.ts";
import { TestOwnerVerifier } from "./helpers/test-owner-verifier.ts";
import { sourceWorkspace } from "./helpers/service-fixture.ts";

const verifier = new TestOwnerVerifier();
const open = (dataRoot: string, extra: Record<string, unknown> = {}) =>
  new StudioService({ dataRoot, tenantId: "rules-check", workspace: sourceWorkspace(), ownerVerifier: verifier, ...extra });

test("the Service binds the pack's budget_defaults, not a hard-coded budget", () => {
  const packs = mkdtempSync(join(tmpdir(), "studio-packs-budget-"));
  cpSync(join(REPO_ROOT, "packs"), packs, { recursive: true });
  const manifest = join(packs, "conversion-copywriting/pack.json");
  const pack = JSON.parse(readFileSync(manifest, "utf8"));
  pack.budget_defaults = { max_model_calls: 7, max_steps: 20, max_revision_rounds: 2 };
  writeFileSync(manifest, JSON.stringify(pack));
  const dir = mkdtempSync(join(tmpdir(), "studio-authority-budget-"));
  const store = new AuthorityStore(dir);
  const direction = { session: "budget-check", idea: "An idea", audience: "fictional readers", source_paths: ["sources/a.md"], reader_question: "Why?", angle: "A", reader_promise: "P", exclusions: [] };
  store.write("direction_approval", "budget-check", { ...direction, specialist: "conversion-copywriting" });
  store.write("direction_approval", "budget-newsletter", { ...direction, session: "budget-newsletter" });
  const provider = new ServiceAuthorityProvider(store, "ws");
  const bind = (session: string) => provider.bindRequest({ authority_session: session } as never).budget;
  process.env.STUDIO_ALLOW_ENV_OVERRIDES = "1";
  process.env.STUDIO_PACKS_DIR = packs;
  try {
    assert.deepEqual(bind("budget-check"), { max_model_calls: 7, max_steps: 20, max_revision_rounds: 2 });
    assert.deepEqual(bind("budget-newsletter"), { max_model_calls: 12, max_steps: 40, max_revision_rounds: 1 }, "an untouched pack keeps its own default");
  } finally {
    delete process.env.STUDIO_PACKS_DIR;
    delete process.env.STUDIO_ALLOW_ENV_OVERRIDES;
    store.close();
    rmSync(packs, { recursive: true, force: true });
  }
});

test("restarting a tenant with a conflicting --provider or --review-policy is an error, not silently ignored", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "studio-restart-flags-"));
  await open(dataRoot, { provider: "fixture" }).close();
  await open(dataRoot, { provider: "fixture", reviewPolicy: "passkey" }).close(); // same values are fine
  await open(dataRoot).close(); // no flags are fine
  assert.throws(() => open(dataRoot, { provider: "codex-cli" }), /--provider conflicts/);
  assert.throws(() => open(dataRoot, { reviewPolicy: "linear-review", linearAccountId: "someone" }), /review policy fixed at this tenant's first start/);
});

test("request_direction_approval takes pack_id (canonical) or specialist (legacy alias), and the signed request binds that pack", () => {
  const dir = mkdtempSync(join(tmpdir(), "studio-packid-"));
  const service = open(dir);
  const base = { idea: "An idea", audience: "fictional readers", source_paths: ["sources/a.md"], reader_question: "Why?", angle: "A", reader_promise: "P", exclusions: [] };
  const ask = (session: string, extra: Record<string, unknown>): any => service.callTool("request_direction_approval", { session, rationale: "fixture", direction: { ...base, ...extra } });
  try {
    assert.equal(ask("pack-id-s", { pack_id: "conversion-copywriting" }).ok, true, "pack_id is accepted");
    assert.equal(ask("legacy-s", { specialist: "conversion-copywriting" }).ok, true, "specialist still works");
    assert.equal(ask("same-s", { pack_id: "conversion-copywriting", specialist: "conversion-copywriting" }).ok, true);
    assert.deepEqual(ask("differ-s", { pack_id: "newsletter", specialist: "conversion-copywriting" }), { ok: false, error: "INVALID_REQUEST" });
    assert.equal(service.pendingRequests().length, 3);
  } finally {
    void service.close();
  }
  const store = new AuthorityStore(mkdtempSync(join(tmpdir(), "studio-packid-auth-")));
  try {
    store.write("direction_approval", "a", { session: "a", ...base, pack_id: "conversion-copywriting" });
    store.write("direction_approval", "b", { session: "b", ...base, specialist: "conversion-copywriting" });
    const provider = new ServiceAuthorityProvider(store, "ws");
    for (const s of ["a", "b"]) assert.equal(provider.bindRequest({ authority_session: s } as never).pack_id, "conversion-copywriting");
  } finally {
    store.close();
  }
});
