/** One synchronous Runner invocation, deliberately outside the HTTP process. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startAgentRun, resumeAgentRun } from "../agent-run.ts";
import { modelFor } from "../model-port.ts";
import { atomicWrite, readWorkspaceIdentity, RunnerFailure } from "../runner.ts";
import { fixtureModel, tenantModelConfig } from "./studio-service.ts";
import { AuthorityStore, ServiceAuthorityProvider } from "./authority-store.ts";

type Job = {
  job_id: string;
  status: "queued" | "running" | "complete" | "failed";
  request: unknown;
  run_id: string | null;
  error: string | null;
  worker_pid?: number | null;
  updated_at: string;
};

const [workspace, jobFile, tenantDir] = process.argv.slice(2);
const load = () => JSON.parse(readFileSync(jobFile, "utf8")) as Job;
const save = (job: Job) => {
  job.updated_at = new Date().toISOString();
  atomicWrite(jobFile, JSON.stringify(job, null, 2));
};

const execute = (encodedKey: string) => {
try {
  const job = load();
  const requestFile = join(dirname(jobFile), job.job_id + ".request.json");
  if (!existsSync(requestFile))
    atomicWrite(requestFile, JSON.stringify(job.request, null, 2));
  if (!tenantDir) throw new Error("Service authority store is required");
  const tenantModel = tenantModelConfig(JSON.parse(readFileSync(join(tenantDir, "tenant.json"), "utf8")));
  const model = tenantModel.provider === "fixture" ? fixtureModel() : modelFor(tenantModel.provider);
  const authority = new ServiceAuthorityProvider(
    new AuthorityStore(tenantDir, Buffer.from(encodedKey, "base64")),
    readWorkspaceIdentity(workspace),
    tenantModel.provider,
    tenantModel.models,
  );
  const result = job.run_id
    ? resumeAgentRun(workspace, job.run_id, { model, authority })
    : startAgentRun(workspace, requestFile, {
        model,
        authority,
        onRun: (runId) => {
          job.run_id = runId;
          save(job);
        },
      });
  if (typeof result.run_id !== "string")
    throw new Error("Runner returned no run id");
  job.run_id = result.run_id;
  job.status = "complete";
  job.error = null;
  job.worker_pid = null;
  save(job);
} catch (error) {
  const job = load();
  job.status =
    error instanceof RunnerFailure &&
    error.code === "LOCKED" &&
    error.message === "Workspace is already executing a run"
      ? "queued"
      : "failed";
  job.error =
    job.status === "queued"
      ? null
      : error instanceof Error
        ? error.message.slice(0, 300)
        : "Run failed";
  job.worker_pid = null;
  save(job);
  process.exitCode = 1;
}
};

process.once("message", (message: unknown) => {
  if (!message || typeof message !== "object" || typeof (message as { authority_key?: unknown }).authority_key !== "string") {
    process.exitCode = 1;
    return;
  }
  execute((message as { authority_key: string }).authority_key);
});
