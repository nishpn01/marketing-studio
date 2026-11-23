/** Narrow, local-only first-run onboarding. It records context; it never imports sources or calls a model. */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type OnboardingAnswers = {
  company: string;
  product: string;
  audience: string;
  voice: string;
  goals: string;
  sources: string[];
};

export type OnboardingResult = {
  workspace: string;
  workspace_id: string;
  files: string[];
  source_references: number;
  imports_performed: false;
};

const MAX_FIELD = 8_000;
const MAX_SOURCE = 2_000;
const MAX_SOURCES = 20;

function clean(value: unknown, field: string, max = MAX_FIELD): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const out = value.trim();
  if (out.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return out;
}

function workspaceId(company: string): string {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (slug.length < 3) throw new Error("company must produce a workspace id with at least 3 characters");
  return slug;
}

function normalize(raw: unknown): OnboardingAnswers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("onboarding answers must be an object");
  const value = raw as Record<string, unknown>;
  const sources = Array.isArray(value.sources)
    ? value.sources.map((source, i) => clean(source, `sources[${i}]`, MAX_SOURCE))
    : typeof value.sources === "string"
      ? value.sources.split(/\r?\n/).map(x => x.trim()).filter(Boolean).map((source, i) => clean(source, `sources[${i}]`, MAX_SOURCE))
      : [];
  if (sources.length > MAX_SOURCES) throw new Error(`sources cannot contain more than ${MAX_SOURCES} references`);
  return {
    company: clean(value.company, "company"),
    product: clean(value.product, "product"),
    audience: clean(value.audience, "audience"),
    voice: clean(value.voice, "voice"),
    goals: clean(value.goals, "goals"),
    sources,
  };
}

async function interview(): Promise<OnboardingAnswers> {
  const rl = createInterface({ input, output });
  try {
    const company = await rl.question("Company or project name: ");
    const product = await rl.question("What does the product or service do today? ");
    const audience = await rl.question("Who is the primary audience? ");
    const voice = await rl.question("What voice should drafts use? ");
    const goals = await rl.question("What are the near-term marketing goals? ");
    const sources: string[] = [];
    output.write("Source references to connect later (one per line; blank line ends):\n");
    while (sources.length < MAX_SOURCES) {
      const source = (await rl.question("Source reference: ")).trim();
      if (!source) break;
      sources.push(source);
    }
    return normalize({ company, product, audience, voice, goals, sources });
  } finally {
    rl.close();
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function profileMarkdown(answers: OnboardingAnswers): string {
  const refs = answers.sources.length
    ? answers.sources.map((source, i) => `${i + 1}. ${source}`).join("\n")
    : "(none recorded yet)";
  return `# Onboarding profile

This is owner-provided workspace guidance, not source evidence. Source references are recorded for a later, explicit import or catalog step; this command does not fetch, copy, or authenticate them.

## Company or project

${answers.company}

## Product or service

${answers.product}

## Primary audience

${answers.audience}

## Voice

${answers.voice}

## Near-term goals

${answers.goals}

## Source references to connect later

${refs}
`;
}

export async function onboardWorkspace(workspaceArg: string, answersFile?: string, force = false): Promise<OnboardingResult> {
  const workspace = resolve(workspaceArg);
  if (existsSync(workspace) && lstatSync(workspace).isSymbolicLink()) throw new Error("workspace cannot be a symlink");
  if (existsSync(workspace) && !lstatSync(workspace).isDirectory()) throw new Error("workspace must be a directory");
  const existing = ["studio-business.json", "studio-workspace.json", "studio-context.json"].filter(name => existsSync(resolve(workspace, name)));
  if (existing.length && !force) throw new Error(`workspace already has config (${existing.join(", ")}); pass --force only after reviewing it`);

  const answers = answersFile
    ? normalize(JSON.parse(readFileSync(resolve(answersFile), "utf8")))
    : await interview();
  const id = workspaceId(answers.company);
  mkdirSync(resolve(workspace, "context"), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(workspace, "sources"), { recursive: true, mode: 0o700 });

  writeJson(resolve(workspace, "studio-workspace.json"), {
    schema_version: "studio.workspace/0.1",
    workspace_id: id,
    sources: [],
  });
  writeJson(resolve(workspace, "studio-business.json"), {
    schema_version: "studio.business/0.1",
    workspace_id: id,
    _note: "Created by local onboarding. Source references are not imported or treated as evidence.",
    vars: {},
    allowed_roots: ["sources"],
    defaults: {
      audience: answers.audience,
      provider: "fixture",
      models: { director: "fixture", writer: "fixture", fact_reviewer: "fixture", craft_reviewer: "fixture" },
      budget: { max_model_calls: 12, max_steps: 40, max_revision_rounds: 1 },
    },
    catalog: [],
    context_sync: [],
    onboarding: {
      company: answers.company,
      product: answers.product,
      goals: answers.goals,
      source_references: answers.sources,
      imports_performed: false,
    },
  });
  writeJson(resolve(workspace, "studio-context.json"), {
    schema_version: "studio.context/0.1",
    files: [{ path: "context/onboarding-profile.md", roles: ["director", "writer", "craft_reviewer"], purpose: "Owner-provided company, product, audience, voice, goals and pending source references" }],
  });
  writeFileSync(resolve(workspace, "context/onboarding-profile.md"), profileMarkdown(answers), { mode: 0o600 });
  return { workspace, workspace_id: id, files: ["studio-workspace.json", "studio-business.json", "studio-context.json", "context/onboarding-profile.md"], source_references: answers.sources.length, imports_performed: false };
}
