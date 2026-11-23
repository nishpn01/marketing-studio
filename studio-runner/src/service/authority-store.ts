/** Signed Service-held authority. Workspace files are never consulted here. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRequest, AuthorityProvider } from "../agent-run.ts";
import { loadPack } from "../pack-loader.ts";

export type AuthorityKind =
  | "source_classification" | "direction_approval" | "plan_approval" | "disclosure_grant" | "revocation" | "editorial_approval"
  // Exact piece final (passkey or linear-review) and the separate destination authorization a future publisher must also find.
  | "piece_final" | "publish_authorization"
  // Bookkeeping kinds: a pending snapshot grants nothing; an owner_decision consumes its subject exactly once.
  | "pending_request" | "owner_decision" | "owner_credential";
export type AuthorityEntry = { kind: AuthorityKind; subject: string; payload: Record<string, unknown> };
type RecordRow = { id: string; kind: AuthorityKind; subject: string; payload: string; created_at: string; signature: string };
type LogRow = { seq: number; record_id: string; record_signature: string; previous_signature: string | null; created_at: string; signature: string };
const text = (value: unknown) => JSON.stringify(value);
const fingerprint = (key: Buffer) => createHash("sha256").update(key).digest("hex");
export const sourceSubject = (path: string, digest: string) => "source-" + createHash("sha256").update(path + "\0" + digest).digest("hex");

export class AuthorityStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly keyFingerprint: string;

  constructor(tenantDir: string, key?: Buffer) {
    const database = join(tenantDir, "authority.sqlite"), keyPath = join(tenantDir, "authority.key");
    if (key) this.key = Buffer.from(key);
    else {
      if (!existsSync(keyPath)) {
        if (existsSync(database)) throw new Error("Authority key is missing for an initialized tenant");
        writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
      }
      const stat = lstatSync(keyPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new Error("Authority key permissions are unsafe");
      this.key = readFileSync(keyPath);
    }
    if (this.key.length !== 32) throw new Error("Authority key is invalid");
    this.keyFingerprint = fingerprint(this.key);
    this.db = new DatabaseSync(database);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authority_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, signature TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS authority_log (seq INTEGER PRIMARY KEY, record_id TEXT NOT NULL, record_signature TEXT NOT NULL, previous_signature TEXT, created_at TEXT NOT NULL, signature TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS authority_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
    const head = this.db.prepare("SELECT value FROM authority_meta WHERE key = ?").get("head") as { value: string } | undefined;
    if (!head) this.db.prepare("INSERT INTO authority_meta VALUES (?, ?)").run("head", text({ seq: 0, key_fingerprint: this.keyFingerprint, signature: this.sign({ seq: 0, key_fingerprint: this.keyFingerprint }) }));
  }

  workerKey() { return Buffer.from(this.key); }
  private sign(value: unknown) { return createHmac("sha256", this.key).update(text(value)).digest("hex"); }
  private signed(value: unknown, signature: string) {
    const expected = Buffer.from(this.sign(value), "hex"), given = Buffer.from(signature, "hex");
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
  private validRecord(row: RecordRow) { return this.signed({ id: row.id, kind: row.kind, subject: row.subject, payload: row.payload, created_at: row.created_at }, row.signature); }
  private healthy() {
    try {
      const records = this.db.prepare("SELECT * FROM authority_records").all() as RecordRow[];
      const byId = new Map(records.map((row) => [row.id, row]));
      const logs = this.db.prepare("SELECT * FROM authority_log ORDER BY seq").all() as LogRow[];
      if (records.length !== logs.length) return false;
      let previous: string | null = null;
      const seen = new Set<string>();
      for (const [index, row] of logs.entries()) {
        const record = byId.get(row.record_id);
        if (!record || seen.has(row.record_id) || !this.validRecord(record) || row.record_signature !== record.signature || row.seq !== index + 1 || row.previous_signature !== previous || !this.signed({ seq: row.seq, record_id: row.record_id, record_signature: row.record_signature, previous_signature: row.previous_signature, created_at: row.created_at }, row.signature)) return false;
        seen.add(row.record_id); previous = row.signature;
      }
      const head = this.db.prepare("SELECT value FROM authority_meta WHERE key = ?").get("head") as { value: string } | undefined;
      if (!head) return false;
      const value = JSON.parse(head.value) as { seq: number; key_fingerprint: string; signature: string };
      return value.seq === logs.length && value.key_fingerprint === this.keyFingerprint && this.signed({ seq: value.seq, key_fingerprint: value.key_fingerprint }, value.signature) && (logs.at(-1)?.signature ?? null) === previous;
    } catch { return false; }
  }
  write(kind: AuthorityKind, subject: string, payload: Record<string, unknown>) {
    return this.writeAll([{ kind, subject, payload }])[0];
  }
  /** Appends every entry in one transaction. With `once`, fails if an owner_decision for that subject already exists. */
  writeAll(entries: AuthorityEntry[], once?: string) {
    if (!entries.length || entries.some(({ subject }) => !/^[a-z0-9][a-z0-9:._-]{0,180}$/i.test(subject)) || !this.healthy()) throw new Error("Authority store integrity check failed");
    const ids: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (once !== undefined && this.db.prepare("SELECT 1 FROM authority_records WHERE kind = 'owner_decision' AND subject = ?").get(once)) throw new Error("Request was already decided");
      let seq = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) seq FROM authority_log").get() as { seq: number }).seq;
      let previous = (this.db.prepare("SELECT signature FROM authority_log ORDER BY seq DESC LIMIT 1").get() as { signature: string } | undefined)?.signature ?? null;
      for (const { kind, subject, payload } of entries) {
        const id = randomBytes(16).toString("hex"), created_at = new Date().toISOString(), raw = text(payload);
        const signature = this.sign({ id, kind, subject, payload: raw, created_at });
        this.db.prepare("INSERT INTO authority_records VALUES (?, ?, ?, ?, ?, ?)").run(id, kind, subject, raw, created_at, signature);
        seq += 1;
        const logSignature = this.sign({ seq, record_id: id, record_signature: signature, previous_signature: previous, created_at });
        this.db.prepare("INSERT INTO authority_log VALUES (?, ?, ?, ?, ?, ?)").run(seq, id, signature, previous, created_at, logSignature);
        previous = logSignature;
        ids.push(id);
      }
      this.db.prepare("UPDATE authority_meta SET value = ? WHERE key = ?").run(text({ seq, key_fingerprint: this.keyFingerprint, signature: this.sign({ seq, key_fingerprint: this.keyFingerprint }) }), "head");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return ids;
  }
  /** Count of log entries; lets tests prove a read path changed nothing. */
  size() { return (this.db.prepare("SELECT COUNT(*) n FROM authority_log").get() as { n: number }).n; }
  latest(kind: AuthorityKind, subject: string): Record<string, unknown> | null {
    if (!this.healthy()) return null;
    const rows = this.db.prepare("SELECT r.* FROM authority_log l JOIN authority_records r ON r.id = l.record_id WHERE r.kind = ? AND r.subject = ? ORDER BY l.seq DESC").all(kind, subject) as RecordRow[];
    for (const row of rows) try { const payload = JSON.parse(row.payload); if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>; } catch {}
    return null;
  }
  active(kind: AuthorityKind) {
    if (!this.healthy()) return [] as { subject: string; payload: Record<string, unknown> }[];
    const subjects = this.db.prepare("SELECT DISTINCT subject FROM authority_records WHERE kind = ?").all(kind) as { subject: string }[];
    return subjects.flatMap(({ subject }) => { const payload = this.latest(kind, subject); return payload ? [{ subject, payload }] : []; });
  }
  close() { this.db.close(); }
}

/** Adapts signed rows to the legacy engine without reading workspace authority files. */
export class ServiceAuthorityProvider implements AuthorityProvider {
  private readonly store: AuthorityStore;
  private readonly workspaceId: string;
  private readonly provider: string;
  private readonly models: AgentRequest["models"];
  constructor(store: AuthorityStore, workspaceId: string, provider = "fixture", models: AgentRequest["models"] = { director: "fixture", writer: "fixture", fact_reviewer: "fixture", craft_reviewer: "fixture", handoff_reader: "fixture" }) {
    this.store = store; this.workspaceId = workspaceId; this.provider = provider; this.models = models;
  }
  bindRequest(request: AgentRequest): AgentRequest {
    const session = request.authority_session, d = session ? this.store.latest("direction_approval", session) : null;
    if (!d || d.session !== session || typeof d.idea !== "string" || typeof d.audience !== "string" || !Array.isArray(d.source_paths) || !d.source_paths.every((path) => typeof path === "string") || !["reader_question", "angle", "reader_promise"].every((key) => typeof d[key] === "string") || !Array.isArray(d.exclusions)) throw new Error("Signed direction approval unavailable");
    const given = d.pack_id ?? d.specialist, pack = typeof given === "string" ? given : "newsletter"; // pack_id is canonical, specialist its legacy alias
    return { schema_version: "studio.request/0.2", workspace_id: this.workspaceId, mode: "one_off", idea: d.idea, audience: d.audience, source_paths: d.source_paths as string[], restricted_sources: Array.isArray(d.restricted_sources) && d.restricted_sources.every((path) => typeof path === "string") ? d.restricted_sources as string[] : [], authority_session: session!, pack_id: pack, ...(typeof given === "string" ? { specialist: given } : {}), disclosure: { session: session!, host: typeof d.host === "string" ? d.host : "other" }, provider: this.provider, models: this.models, budget: loadPack(pack).budget_defaults, permissions: { actions: ["read_sources", "write_private_draft", "run_metadata_gate"] }, approved_direction: { reader_question: d.reader_question as string, angle: d.angle as string, reader_promise: d.reader_promise as string, exclusions: d.exclusions as string[], ...(typeof d.notes === "string" ? { notes: d.notes } : {}), approval_type: "owner", approval_quote: "Recorded through the Service owner channel." } };
  }
  sourceVisibility(path: string, digest: string) { const row = this.store.latest("source_classification", sourceSubject(path, digest)); return row?.path === path && row.digest === digest && (row.visibility === "approved" || row.visibility === "restricted") ? row.visibility : null; }
  sourceDisclosure(input: { path: string; digest: string; body: string; session?: string; host?: string; purpose: string; roles: string[] }) {
    if (!input.session || input.purpose !== "drafting") return null;
    const views: Record<string, string> = {}, used: Record<string, string> = {};
    for (const { subject, payload } of this.store.active("disclosure_grant")) {
      if (this.store.latest("revocation", subject) || payload.path !== input.path || payload.digest !== input.digest || payload.session !== input.session || payload.host !== input.host || payload.purpose !== input.purpose || !Array.isArray(payload.roles) || !Array.isArray(payload.excerpts) || payload.excerpts.some((excerpt) => typeof excerpt !== "string" || !input.body.includes(excerpt))) continue;
      for (const role of payload.roles) { if (typeof role !== "string" || views[role]) return null; views[role] = (payload.excerpts as string[]).join("\n\n"); used[role] = subject; }
    }
    return input.roles.some((role) => !views[role]) ? null : { views, sig: createHash("sha256").update(text(Object.keys(views).sort().map((role) => [role, used[role], views[role]]))).digest("hex") };
  }
}
