/**
 * Owner Inbox v0: server-rendered pages on http://localhost:<port>/inbox, separate from bearer-token /mcp.
 * GET only renders. Every POST needs the inbox Host and Origin, a CSRF token tied to an HttpOnly SameSite=Strict
 * cookie, and JSON; every authority action also needs its own passkey assertion bound to what the page showed.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OwnerAction, StudioService } from "./studio-service.ts";

const CSRF_TTL_MS = 15 * 60_000;
const ACTIONS: OwnerAction[] = ["approve", "reject", "revoke", "approve_version", "revise"];
const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class OwnerInbox {
  private readonly service: StudioService;
  private readonly secret = randomBytes(32);
  constructor(service: StudioService) { this.service = service; }

  private token(sid: string) { return createHmac("sha256", this.secret).update(sid).digest("base64url"); }
  private session(req: IncomingMessage) {
    const sid = /(?:^|;\s*)inbox_csrf=([A-Za-z0-9_-]+\.[0-9]+)(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
    return sid && Date.now() - Number(sid.split(".")[1]) < CSRF_TTL_MS ? sid : null;
  }
  private csrfValid(req: IncomingMessage) {
    const sid = this.session(req), given = req.headers["x-inbox-csrf"];
    if (!sid || typeof given !== "string") return false;
    const a = Buffer.from(given), b = Buffer.from(this.token(sid));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async handle(req: IncomingMessage, res: ServerResponse, port: number) {
    const origin = "http://localhost:" + port;
    // Bearer tokens belong to /mcp and never authorize anything here; refuse rather than ignore them.
    if (req.headers.authorization) return this.json(res, 401, { error: "BEARER_NOT_ACCEPTED" });
    // A fixed Host stops DNS rebinding and keeps the inbox origin distinct from the 127.0.0.1 MCP origin.
    if (req.headers.host !== "localhost:" + port) return this.json(res, 403, { error: "WRONG_HOST" });
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET") return this.page(req, res, path);
    if (req.method !== "POST" || !path.startsWith("/inbox/api/")) return this.json(res, 405, { error: "METHOD_NOT_ALLOWED" });
    const site = req.headers["sec-fetch-site"];
    if (req.headers.origin !== origin || (site !== undefined && site !== "same-origin")) return this.json(res, 403, { error: "FOREIGN_ORIGIN" });
    if (!/^application\/json(;|$)/.test(req.headers["content-type"] ?? "")) return this.json(res, 415, { error: "JSON_REQUIRED" });
    if (!this.csrfValid(req)) return this.json(res, 403, { error: "CSRF" });
    const raw = await this.service.body(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw ?? "");
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch {
      return this.json(res, 400, { error: "INVALID_REQUEST" });
    }
    try {
      return this.json(res, 200, this.api(path, body, this.session(req) + "|" + req.socket.remoteAddress));
    } catch (error) {
      return this.json(res, 409, { error: error instanceof Error ? error.message : "Refused" });
    }
  }

  private api(path: string, body: Record<string, unknown>, client: string) {
    if (path === "/inbox/api/idea_dismiss") return this.service.ideaDismiss(body.id as string);
    if (path === "/inbox/api/idea_promote") return this.service.ideaPromote(body.id as string);
    const passkeys = this.service.passkeys;
    if (!passkeys) throw new Error("Passkey verifier is not configured");
    if (path === "/inbox/api/register-options") return passkeys.registrationOptions(body.code, client);
    if (path === "/inbox/api/register") return passkeys.register(body.code, this.object(body.credential), client);
    const action = body.action as OwnerAction;
    if (!ACTIONS.includes(action) || typeof body.target !== "string" || typeof body.digest !== "string") throw new Error("Invalid owner action");
    if (path === "/inbox/api/challenge") return this.service.ownerChallenge(action, body.target, body.digest);
    if (path === "/inbox/api/decide") {
      const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 4000) : undefined;
      return this.service.ownerDecide(action, body.target, body.digest, passkeys.assertionFrom(this.object(body.credential)), notes);
    }
    throw new Error("Unknown inbox endpoint");
  }
  private object(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Owner assertion is required");
    return value as Record<string, unknown>;
  }

  private page(req: IncomingMessage, res: ServerResponse, path: string) {
    let title: string, body: string;
    try {
      const view = this.view(path);
      if (!view) return this.json(res, 404, { error: "NOT_FOUND" });
      [title, body] = view;
    } catch (error) {
      [title, body] = ["Unavailable", `<p>${esc(error instanceof Error ? error.message : "Unavailable")}</p><p><a href="/inbox">Back to the inbox</a></p>`];
    }
    const sid = this.session(req) ?? randomBytes(16).toString("base64url") + "." + Date.now();
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "set-cookie": `inbox_csrf=${sid}; HttpOnly; SameSite=Strict; Path=/inbox; Max-Age=${CSRF_TTL_MS / 1000}`,
    });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="inbox-csrf" content="${esc(this.token(sid))}"><title>${esc(title)} · Studio inbox</title>
<style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
pre{white-space:pre-wrap;background:#f5f5f2;padding:1rem;border-radius:6px}code{font-size:.85em;word-break:break-all}
dt{font-weight:600;margin-top:.6rem}button{font:inherit;padding:.4rem 1rem;margin-right:.5rem}textarea{width:100%;font:inherit}
.status{margin-top:1rem;font-weight:600}</style></head><body><h1>${esc(title)}</h1>${body}
<script nonce="${nonce}">${CLIENT}</script></body></html>`);
  }

  /** Read-only views. Nothing here writes authority, consumes a request or issues a challenge. */
  private view(path: string): [string, string] | null {
    const s = this.service;
    if (path === "/inbox" || path === "/inbox/") {
      const setup = s.passkeys && !s.passkeys.credential() ? `<p><strong>No owner passkey yet.</strong> <a href="/inbox/setup">Register one</a> with the code the Service printed in its terminal.</p>` : "";
      const pending = s.pendingRequests().map(({ request }) => `<li><a href="/inbox/requests/${esc(request.request_id)}">${esc(request.type === "direction_approval" ? "Direction" : request.type === "plan_approval" ? "Program plan" : request.type === "piece_final" ? "Piece final" : "Disclosure grant")} for session ${esc(request.session)}</a> · ${esc(request.created_at)}</li>`);
      const runs = s.reviewQueue().map((r) => `<li><a href="/inbox/runs/${esc(r.job_id)}">Run ${esc(r.run_id)} · ${esc(r.version)}</a></li>`);
      const grants = s.activeGrants().map(({ subject, grant }) => `<li><a href="/inbox/grants/${esc(subject)}">${esc(grant.path)} for session ${esc(grant.session)}</a></li>`);
      const ideas = (s.ideasList().result as any).ideas.map((i: any) => `<li><a href="/inbox/ideas/${esc(i.id)}">${esc(i.kind)}: ${esc(i.title)}</a> · ${esc(i.created_at)}</li>`);
      const list = (items: string[], empty: string) => items.length ? `<ul>${items.join("")}</ul>` : `<p>${empty}</p>`;
      return ["Owner inbox", `${setup}<h2>Pending requests</h2>${list(pending, "Nothing pending.")}<h2>Drafts waiting for review</h2>${list(runs, "No drafts waiting.")}<h2>Active disclosure grants</h2>${list(grants, "No active grants.")}<h2>Proactive ideas</h2>${list(ideas, "No open ideas.")}`];
    }
    if (path === "/inbox/setup") {
      if (!s.passkeys) return ["Setup unavailable", "<p>This Service uses a test verifier.</p>"];
      if (s.passkeys.credential()) return ["Owner passkey registered", `<p>Registration is closed. <a href="/inbox">Open the inbox</a>.</p>`];
      return ["Register the owner passkey", `<p>Enter the one-time code the Service printed in the terminal that started it. The code expires 10 minutes after start.</p>
<p><input id="code" autocomplete="off" size="30" aria-label="Setup code"></p><button id="register">Register passkey</button><div class="status" id="status" role="status"></div>`];
    }
    let match = /^\/inbox\/requests\/(pending-[0-9a-f]{16})$/.exec(path);
    if (match) {
      const item = s.pendingRequests().find(({ request }) => request.request_id === match![1]);
      if (!item) throw new Error("This request is unavailable or was already decided.");
      const { request: r, digest } = item;
      const fields: [string, unknown][] = r.type === "direction_approval"
        ? Object.entries(r.direction ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.join("\n") : value])
        : r.type === "plan_approval"
          ? [["program id", r.program?.program_id], ["plan sha256", r.program?.plan_digest], ["Linear plan revision", r.program?.document_revision ?? "not synced to Linear"]]
          : r.type === "piece_final" && r.final
            ? [["program id", r.final.program_id], ["piece id", r.final.piece_id], ["version", r.final.version], ["draft sha256", r.final.digest], ["QA digest", r.final.qa_digest], ["Linear document revision", r.final.document_revision], ["scope", "Private editorial final of exactly these bytes. Not publication, scheduling or any account change."], ["draft", s.finalDraft(r.final)]]
            : [["path", r.grant?.path], ["source sha256", r.grant?.source_digest], ["roles", r.grant?.roles.join(", ")], ...(r.grant?.excerpts ?? []).map((excerpt, i): [string, unknown] => ["excerpt " + (i + 1), excerpt])];
      return [r.type === "direction_approval" ? "Approve a direction?" : r.type === "plan_approval" ? "Approve this exact program plan?" : r.type === "piece_final" ? "Finalize this exact piece version?" : "Grant a disclosure?", `<dl><dt>Session</dt><dd>${esc(r.session)}</dd><dt>Host</dt><dd>${esc(r.host)}</dd><dt>Agent's rationale</dt><dd><pre>${esc(r.rationale)}</pre></dd>
${fields.map(([key, value]) => `<dt>${esc(key)}</dt><dd><pre>${esc(value)}</pre></dd>`).join("")}</dl>
<p>Request <code>${esc(r.request_id)}</code>, snapshot sha256 <code>${esc(digest)}</code></p>${this.actions(r.request_id, digest, [["approve", "Approve"], ["reject", "Reject"]])}`];
    }
    match = /^\/inbox\/ideas\/(idea-[0-9a-f]{12})$/.exec(path);
    if (match) {
      const item = (s.ideasList().result as any).ideas.find((i: any) => i.id === match![1]);
      // allow dismissed/promoted too? list only open; fetch from readIdeas via service not exposed. Use ideasList only open; if not found, try promote/dismissed by scanning? Keep simple: if not in open list, show unavailable.
      if (!item) throw new Error("This idea is unavailable or was already decided.");
      const refs = (item.source_refs as string[]).map((r) => `<li><code>${esc(r)}</code></li>`).join("");
      const promoteBtn = item.kind === "content_idea" ? `<button data-idea-action="idea_promote" data-idea-id="${esc(item.id)}">Promote to direction</button>` : "";
      return [`Idea ${item.title}`, `<dl><dt>Kind</dt><dd>${esc(item.kind)}</dd><dt>Title</dt><dd>${esc(item.title)}</dd><dt>Rationale</dt><dd><pre>${esc(item.rationale)}</pre></dd><dt>Source refs</dt><dd><ul>${refs}</ul></dd></dl>
<p>Idea <code>${esc(item.id)}</code></p><div><button data-idea-action="idea_dismiss" data-idea-id="${esc(item.id)}">Dismiss</button>${promoteBtn}</div><div class="status" id="status" role="status"></div><p><a href="/inbox">Back to the inbox</a></p>`];
    }
    match = /^\/inbox\/grants\/(grant-[0-9a-z]{1,40})$/.exec(path);
    if (match) {
      const item = s.activeGrants().find(({ subject }) => subject === match![1]);
      if (!item) throw new Error("This grant is unavailable or was already revoked.");
      const g = item.grant;
      return ["Active disclosure grant", `<dl><dt>Path</dt><dd>${esc(g.path)}</dd><dt>Session</dt><dd>${esc(g.session)}</dd><dt>Roles</dt><dd>${esc((g.roles as string[]).join(", "))}</dd>
${(g.excerpts as string[]).map((excerpt, i) => `<dt>excerpt ${i + 1}</dt><dd><pre>${esc(excerpt)}</pre></dd>`).join("")}</dl>
<p>Grant sha256 <code>${esc(item.digest)}</code></p>${this.actions(item.subject, item.digest, [["revoke", "Revoke"]])}`];
    }
    match = /^\/inbox\/runs\/(job-[0-9a-f]{16})$/.exec(path);
    if (match) {
      const r = s.reviewPackage(match[1]);
      return [`Review ${r.version}`, `<p>Run <code>${esc(r.run_id)}</code>, version ${esc(r.version)}, draft sha256 <code>${esc(r.digest)}</code>. Approval covers exactly these draft bytes and never authorizes publication.</p>
<h2>Draft</h2><pre>${esc(r.draft)}</pre><h2>Review package</h2><pre>${esc(r.package)}</pre>
<p><label for="notes">Notes for a revision</label><textarea id="notes" rows="4"></textarea></p>${this.actions(r.job_id, r.digest, [["approve_version", "Approve this version"], ["revise", "Ask for a revision"]])}`];
    }
    return null;
  }
  private actions(target: string, digest: string, buttons: [OwnerAction, string][]) {
    return `<div>${buttons.map(([action, label]) => `<button data-action="${action}" data-target="${esc(target)}" data-digest="${esc(digest)}">${esc(label)}</button>`).join("")}</div>
<div class="status" id="status" role="status"></div><p><a href="/inbox">Back to the inbox</a></p>`;
  }
  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }
}

/** Browser side: fetch a bound challenge, ask the authenticator, post the assertion. No external assets. */
const CLIENT = `
const csrf = document.querySelector('meta[name="inbox-csrf"]').content;
const status = (text) => { const el = document.getElementById("status"); if (el) el.textContent = text; };
const enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-inbox-csrf": csrf }, body: JSON.stringify(body), credentials: "same-origin" });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || "Refused");
  return out;
}
for (const button of document.querySelectorAll("button[data-action]")) button.addEventListener("click", async () => {
  const { action, target, digest } = button.dataset;
  try {
    status("Waiting for your passkey...");
    const options = await api("/inbox/api/challenge", { action, target, digest });
    const credential = await navigator.credentials.get({ publicKey: { challenge: dec(options.challenge), rpId: options.rpId, timeout: options.timeout, userVerification: "required",
      allowCredentials: options.allowCredentials.map((c) => ({ type: c.type, id: dec(c.id) })) } });
    const notes = document.getElementById("notes")?.value || undefined;
    await api("/inbox/api/decide", { action, target, digest, notes, credential: { credential_id: enc(credential.rawId), client_data_json: enc(credential.response.clientDataJSON),
      authenticator_data: enc(credential.response.authenticatorData), signature: enc(credential.response.signature) } });
    status("Recorded. Returning to the inbox...");
    setTimeout(() => { location.href = "/inbox"; }, 800);
  } catch (error) { status("Not recorded: " + error.message); }
});
for (const button of document.querySelectorAll("button[data-idea-action]")) button.addEventListener("click", async () => {
  const { ideaAction, ideaId } = button.dataset;
  try {
    status("Working...");
    const res = await fetch("/inbox/api/" + ideaAction, { method: "POST", headers: { "content-type": "application/json", "x-inbox-csrf": csrf }, body: JSON.stringify({ id: ideaId }), credentials: "same-origin" });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Refused");
    status("Done. Returning to the inbox...");
    setTimeout(() => { location.href = "/inbox"; }, 800);
  } catch (error) { status("Not done: " + error.message); }
});
document.getElementById("register")?.addEventListener("click", async () => {
  try {
    const code = document.getElementById("code").value.trim();
    const o = await api("/inbox/api/register-options", { code });
    const credential = await navigator.credentials.create({ publicKey: { challenge: dec(o.challenge), rp: o.rp, user: { ...o.user, id: dec(o.user.id) }, pubKeyCredParams: o.pubKeyCredParams,
      authenticatorSelection: o.authenticatorSelection, attestation: o.attestation, timeout: o.timeout } });
    const r = credential.response;
    await api("/inbox/api/register", { code, credential: { credential_id: enc(credential.rawId), client_data_json: enc(r.clientDataJSON), authenticator_data: enc(r.getAuthenticatorData()),
      public_key: enc(r.getPublicKey()), public_key_algorithm: r.getPublicKeyAlgorithm() } });
    status("Passkey registered. Opening the inbox...");
    setTimeout(() => { location.href = "/inbox"; }, 800);
  } catch (error) { status("Not registered: " + error.message); }
});
`;
