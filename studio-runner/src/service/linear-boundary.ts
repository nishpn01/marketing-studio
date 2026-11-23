/** Typed host boundary only. Studio neither stores a Linear credential nor calls Linear. */
import { createHash } from "node:crypto";
import { hash } from "../runner.ts";

export type LinearOperation = {
  kind: "project.upsert" | "document.upsert" | "issue.upsert";
  client_key: string;
  fields: Record<string, unknown>;
};

export type LinearChangeSet = {
  schema_version: "studio.linear-change-set/0.1";
  operation_id: string;
  tenant_id: string;
  program_id: string;
  idempotency_key: string;
  preconditions: { project_id?: string; external_revisions: Record<string, string> };
  operations: LinearOperation[];
};

export type LinearReceiptObject = {
  client_key: string;
  object_type?: "project" | "issue" | "document";
  external_id: string;
  external_url?: string;
  external_revision: string;
};

export type LinearReceipt = {
  schema_version: "studio.linear-receipt/0.1";
  operation_id: string;
  idempotency_key: string;
  status: "pending" | "applied" | "conflict" | "failed";
  objects: LinearReceiptObject[];
  connector_label?: string;
  applied_at?: string;
  error?: { code: string; message: string };
};

export type LinearDocumentRead = {
  document_id: string;
  client_key: string;
  body: string;
  external_revision: string;
  updated_at: string;
  digest: string;
};

export type LinearComment = {
  comment_id: string;
  author?: { account_id?: string; display_name?: string };
  body: string;
  created_at: string;
  updated_at: string;
  document_id: string;
  issue_id?: string;
};

export type LinearReadRequest =
  | { kind: "linear.document.read"; document_id: string }
  | { kind: "linear.comments.list"; document_id: string }
  | { kind: "linear.project.read"; project_id: string }
  | { kind: "linear.issue.read"; issue_id: string };

const OPERATION = /^op-[a-f0-9]{16}$/;
const ID = /^[a-z0-9][a-z0-9:._-]{0,240}$/i;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;
const forbiddenKey = /(?:token|credential|password|secret|api[_-]?key|authorization)/i;

function hasCredentialKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasCredentialKey);
  return Object.entries(value).some(([key, nested]) => forbiddenKey.test(key) || hasCredentialKey(nested));
}

function validateObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasCredentialKey(value)) throw new Error("Invalid Linear boundary value");
}

export function validateChangeSet(raw: unknown): LinearChangeSet {
  validateObject(raw);
  const value = raw as Partial<LinearChangeSet>;
  if (value.schema_version !== "studio.linear-change-set/0.1" || !OPERATION.test(String(value.operation_id)) || !ID.test(String(value.tenant_id)) || !/^program-[a-f0-9]{16}$/.test(String(value.program_id)) || !ID.test(String(value.idempotency_key)) || !value.preconditions || typeof value.preconditions !== "object" || Array.isArray(value.preconditions) || !value.preconditions.external_revisions || typeof value.preconditions.external_revisions !== "object" || Array.isArray(value.preconditions.external_revisions) || !Array.isArray(value.operations) || value.operations.length < 1 || value.operations.some((operation) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return true;
    const item = operation as LinearOperation;
    return !["project.upsert", "document.upsert", "issue.upsert"].includes(item.kind) || !ID.test(item.client_key) || !item.fields || typeof item.fields !== "object" || Array.isArray(item.fields) || hasCredentialKey(item.fields);
  })) throw new Error("Invalid Linear change set");
  for (const revision of Object.values(value.preconditions.external_revisions)) if (!REVISION.test(revision)) throw new Error("Invalid Linear precondition");
  return structuredClone(value as LinearChangeSet);
}

export function validateReceipt(raw: unknown): LinearReceipt {
  validateObject(raw);
  const value = raw as Partial<LinearReceipt>;
  if (value.schema_version !== "studio.linear-receipt/0.1" || !OPERATION.test(String(value.operation_id)) || !ID.test(String(value.idempotency_key)) || !["pending", "applied", "conflict", "failed"].includes(String(value.status)) || !Array.isArray(value.objects) || value.objects.some((object) => {
    if (!object || typeof object !== "object" || Array.isArray(object)) return true;
    const item = object as LinearReceiptObject;
    return !ID.test(item.client_key) || !ID.test(item.external_id) || !REVISION.test(item.external_revision) || (item.external_url !== undefined && typeof item.external_url !== "string");
  }) || (value.error !== undefined && (!value.error || typeof value.error !== "object" || Array.isArray(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string"))) throw new Error("Invalid Linear receipt");
  return structuredClone(value as LinearReceipt);
}

export const operationId = (value: unknown) => "op-" + hash(JSON.stringify(value)).slice(0, 16);

type FakeObject = {
  client_key: string;
  object_type: "project" | "issue" | "document";
  external_id: string;
  external_url: string;
  external_revision: string;
  fields: Record<string, unknown>;
  comments: LinearComment[];
  updated_at: string;
};

/** In-memory host connector used by CI; it never models or stores a credential. */
export class FakeLinearAdapter {
  private readonly objects = new Map<string, FakeObject>();
  private readonly applied = new Map<string, LinearReceipt>();
  private failure: { code: string; message: string } | null = null;
  private nextComment = 1;

  failNext(message = "fake connector failure") { this.failure = { code: "CONNECTOR", message }; }

  apply(raw: unknown): LinearReceipt {
    const changeSet = validateChangeSet(raw);
    const prior = this.applied.get(changeSet.idempotency_key);
    if (prior) return structuredClone(prior);
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      return { schema_version: "studio.linear-receipt/0.1", operation_id: changeSet.operation_id, idempotency_key: changeSet.idempotency_key, status: "failed", objects: [], connector_label: "fake-linear", error };
    }
    for (const [clientKey, expected] of Object.entries(changeSet.preconditions.external_revisions)) {
      const actual = this.objects.get(clientKey)?.external_revision;
      if (actual !== expected) return { schema_version: "studio.linear-receipt/0.1", operation_id: changeSet.operation_id, idempotency_key: changeSet.idempotency_key, status: "conflict", objects: [], connector_label: "fake-linear", error: { code: "STALE_PRECONDITION", message: `${clientKey} is ${actual ?? "missing"}, expected ${expected}` } };
    }
    const now = new Date().toISOString();
    const objects = changeSet.operations.map((operation) => {
      const objectType = operation.kind.split(".")[0] as FakeObject["object_type"];
      const current = this.objects.get(operation.client_key);
      const external_id = current?.external_id ?? "lin-" + createHash("sha256").update(operation.client_key).digest("hex").slice(0, 16);
      const external_revision = "r" + (current ? Number(current.external_revision.slice(1)) + 1 : 1);
      const object: FakeObject = { client_key: operation.client_key, object_type: objectType, external_id, external_url: `https://linear.invalid/${external_id}`, external_revision, fields: structuredClone(operation.fields), comments: current?.comments ?? [], updated_at: now };
      this.objects.set(operation.client_key, object);
      return { client_key: operation.client_key, object_type: objectType, external_id, external_url: object.external_url, external_revision };
    });
    const receipt: LinearReceipt = { schema_version: "studio.linear-receipt/0.1", operation_id: changeSet.operation_id, idempotency_key: changeSet.idempotency_key, status: "applied", objects, connector_label: "fake-linear", applied_at: now };
    this.applied.set(changeSet.idempotency_key, receipt);
    return structuredClone(receipt);
  }

  editDocument(clientKey: string, body: string) {
    const object = this.objects.get(clientKey);
    if (!object || object.object_type !== "document") throw new Error("Fake document not found");
    object.fields = { ...object.fields, body };
    object.external_revision = "r" + (Number(object.external_revision.slice(1)) + 1);
    object.updated_at = new Date().toISOString();
  }

  addComment(clientKey: string, body: string, author: LinearComment["author"] = { account_id: "fake-owner", display_name: "Fake owner" }) {
    const object = this.objects.get(clientKey);
    if (!object || object.object_type !== "document") throw new Error("Fake document not found");
    const now = new Date().toISOString();
    object.comments.push({ comment_id: `comment-${this.nextComment++}`, author, body, created_at: now, updated_at: now, document_id: object.external_id });
    return object.comments.at(-1)!;
  }

  readDocument(clientKey: string): LinearDocumentRead {
    const object = this.objects.get(clientKey);
    if (!object || object.object_type !== "document") throw new Error("Fake document not found");
    const body = typeof object.fields.body === "string" ? object.fields.body : JSON.stringify(object.fields.body ?? "");
    return { document_id: object.external_id, client_key: clientKey, body, external_revision: object.external_revision, updated_at: object.updated_at, digest: hash(body) };
  }

  listComments(clientKey: string) {
    const object = this.objects.get(clientKey);
    if (!object || object.object_type !== "document") throw new Error("Fake document not found");
    return structuredClone(object.comments);
  }

  counts() {
    return { projects: [...this.objects.values()].filter((object) => object.object_type === "project").length, issues: [...this.objects.values()].filter((object) => object.object_type === "issue").length, documents: [...this.objects.values()].filter((object) => object.object_type === "document").length };
  }
}

/** CI-only receipt boundary retained for callers that only need receipt storage. */
export class FakeReceiptStore {
  private readonly receipts = new Map<string, LinearReceipt>();
  put(raw: LinearReceipt) {
    const receipt = validateReceipt(raw);
    this.receipts.set(receipt.operation_id, structuredClone(receipt));
    return this.get(receipt.operation_id)!;
  }
  get(operationId: string) {
    const receipt = this.receipts.get(operationId);
    return receipt && structuredClone(receipt);
  }
}
