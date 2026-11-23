/**
 * Explicit, authorized conversation capture. An owner exports or pastes a conversation; the CLI normalizes it
 * into attributed messages (owner vs model), redacts private data, hashes it, and stores it in the business
 * workspace. The host Director then records decisions, reasons, alternatives and open questions as items whose
 * quotes are verified verbatim against the right speaker. Captures are conversation records, never evidence:
 * nothing captured is a permitted public claim, and model statements are labelled as such.
 * Hosts do not expose past chats by API; this only works on files the owner supplies.
 */
import { redactAll } from './redact.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { RunnerFailure, hash, now, atomicWrite } from './runner.ts';

type Speaker = 'owner' | 'model' | 'other';
type Msg = { i: number; speaker: Speaker; text: string; at: string | null };
const ITEM_TYPES = ['idea', 'owner_question', 'decision', 'reason', 'alternative', 'rejected', 'uncertainty', 'open_question', 'source_link', 'artifact_ref'] as const;
const FORMATS = ['studio', 'text', 'chatgpt-export', 'claude-export', 'claude-code-jsonl'] as const;
const LOCAL = /[A-Za-z0-9._%+-]/, DOMAIN = /[A-Za-z0-9.-]/, WORD = /^[\w.-]+$/, PART = /^[\w-]+$/;
/** Linear-time email scan: anchor on '@', bounded expansion each side (no backtracking regex). */
export function redactEmails(t: string): { text: string; count: number } {
  let out = '', at = 0, count = 0;
  for (let i = t.indexOf('@'); i >= 0; i = t.indexOf('@', i + 1)) {
    let a = i; while (a > at && i - a < 64 && LOCAL.test(t[a - 1])) a--;
    let b = i + 1; while (b < t.length && b - i < 256 && DOMAIN.test(t[b])) b++;
    const run = t.slice(i + 1, b); const dot = run.search(/\.[A-Za-z]{2,}(?![A-Za-z])/); // first dot+letters
    if (a === i || dot < 0) continue;
    let e = i + 1 + dot + 1; while (e < b && /[A-Za-z]/.test(t[e])) e++;
    out += t.slice(at, a) + '[email redacted]'; at = e; count++; i = Math.max(i, e - 1);
  }
  return { text: out + t.slice(at), count };
}
/** Linear-time "name dot x at host dot tld" scan over space-separated tokens. */
export function redactObfuscatedEmails(t: string): { text: string; count: number } {
  const tok = t.split(' '), out: string[] = []; let count = 0;
  for (let i = 0; i < tok.length; i++) {
    if (i >= 1 && i < tok.length - 3 && tok[i].toLowerCase() === 'at' && out.length && WORD.test(tok[i - 1]) && PART.test(tok[i + 1])) {
      let m = i + 1, groups = 0; while (m + 2 < tok.length && tok[m + 1].toLowerCase() === 'dot' && PART.test(tok[m + 2])) { m += 2; groups++; }
      if (groups) {
        out.pop(); // the local-part word
        for (let k = 0; k < 20 && out.length >= 2 && out.at(-1)!.toLowerCase() === 'dot' && PART.test(out.at(-2)!); k++) out.length -= 2;
        out.push('[email redacted]'); count++; i = m; continue;
      }
    }
    out.push(tok[i]);
  }
  return { text: out.join(' '), count };
}
/** Default redactions applied to every capture before storage. Owner profile can add exact strings. */
const DEFAULT_REDACT: [RegExp, string][] = [
  [/\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g, '[secret redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,2048}/gi, '[secret redacted]'],
  [/\b(?:[sr]k_(?:live|test)_|pk_live_|AIza|sk-(?:ant-)?|ghp_|gho_|xox[bp]-|AKIA)[A-Za-z0-9_-]{12,512}/g, '[secret redacted]'],
  [/(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?!\d)/g, '[phone redacted]'],
  [/(?<![\d-])(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\d-])/g, '[phone redacted]'],
];

/** Default PII/secret patterns plus the owner's profile strings. */
function redactText(t: string, profile: string[], redactions: Record<string, number> = {}): string {
  for (const fn of [redactEmails, redactObfuscatedEmails]) { const r = fn(t); if (r.count) redactions['[email redacted]'] = (redactions['[email redacted]'] ?? 0) + r.count; t = r.text; }
  for (const [rx, label] of DEFAULT_REDACT) t = t.replace(rx, () => { redactions[label] = (redactions[label] ?? 0) + 1; return label; });
  const r = redactAll(t, profile, '[omitted for privacy]'); if (r.count) redactions['[profile redaction]'] = (redactions['[profile redaction]'] ?? 0) + r.count;
  return r.text;
}
function captureConfig(root: string): { enabled: boolean; allowed_hosts: string[]; redact: string[] } {
  const f = join(root, 'studio-business.json');
  if (!existsSync(f)) throw new RunnerFailure('INPUT', 'This workspace has no studio-business.json');
  const c = JSON.parse(readFileSync(f, 'utf8')).capture;
  return { enabled: c?.enabled === true, allowed_hosts: Array.isArray(c?.allowed_hosts) ? c.allowed_hosts : [], redact: Array.isArray(c?.redact) ? c.redact : [] };
}
const capDir = (root: string, id: string) => { if (!/^cap-[0-9a-f]{12}$/.test(id)) throw new RunnerFailure('INPUT', 'Capture ids look like cap-<12 hex>'); return join(root, 'captures', id); };
/** Drop blocks `<name>...</name>` in linear time: closers are indexed once, so unclosed openers never rescan the text. Unclosed openers are kept. */
function dropBlocks(t: string, names: string): string {
  const closers = new Map<string, number[]>(), ptr = new Map<string, number>();
  for (const m of t.matchAll(new RegExp(`</(${names})>`, 'g'))) { const a = closers.get(m[1]) ?? []; a.push(m.index!); closers.set(m[1], a); }
  const open = new RegExp(`<(${names})>`, 'y'); let out = '', at = 0;
  for (let i = t.indexOf('<'); i >= 0; i = t.indexOf('<', i + 1)) {
    if (i < at) continue;
    open.lastIndex = i; const m = open.exec(t); if (!m) continue;
    const list = closers.get(m[1]) ?? []; let k = ptr.get(m[1]) ?? 0;
    const from = i + m[0].length; while (k < list.length && list[k] < from) k++; ptr.set(m[1], k);
    if (k >= list.length) continue;
    out += t.slice(at, i); at = list[k] + m[1].length + 3;
  }
  return out + t.slice(at);
}
/** Reminder blocks first, then command tags, as the original two-pass code did. */
const strip = (t: string) => dropBlocks(dropBlocks(t, 'system-reminder'), 'local-command-[a-z]+|command-[a-z]+').trim();
const iso = (v: unknown): string | null => typeof v === 'number' ? new Date(v * 1000).toISOString() : typeof v === 'string' && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;

// ---------- parsers ----------
function parseText(raw: string): Omit<Msg, 'i'>[] {
  const OWNER = /^(owner|me|user|you|human)\s*:\s?/i, MODEL = /^(assistant|chatgpt|claude|ai|model|codex|director)\s*:\s?/i;
  const out: Omit<Msg, 'i'>[] = [];
  for (const line of raw.split('\n')) {
    const o = OWNER.exec(line), m = MODEL.exec(line);
    if (o || m) { out.push({ speaker: o ? 'owner' : 'model', text: line.slice((o ?? m)![0].length), at: null }); continue; }
    if (!out.length) { if (line.trim()) throw new RunnerFailure('INPUT', 'Text transcripts must start with a speaker label such as "Owner:" or "Assistant:"; refusing to guess attribution'); continue; }
    out[out.length - 1].text += '\n' + line;
  }
  return out;
}
function parseChatGpt(raw: any, convId?: string): { id: string | null; messages: Omit<Msg, 'i'>[] } {
  const list = Array.isArray(raw) ? raw : [raw];
  const conv = convId ? list.find(c => c.id === convId || c.conversation_id === convId) : list.length === 1 ? list[0] : null;
  if (!conv?.mapping) throw new RunnerFailure('INPUT', list.length > 1 && !convId ? 'Export has several conversations; pass --conversation-id' : 'Not a ChatGPT conversation export (no mapping)');
  const chain: any[] = []; let node = conv.mapping[conv.current_node];
  while (node) { if (node.message) chain.push(node.message); node = node.parent ? conv.mapping[node.parent] : null; }
  const messages = chain.reverse().flatMap(m => {
    const role = m.author?.role; if (role !== 'user' && role !== 'assistant') return [];
    const text = (m.content?.parts ?? []).filter((p: unknown) => typeof p === 'string').join('\n').trim();
    return text ? [{ speaker: role === 'user' ? 'owner' as const : 'model' as const, text, at: iso(m.create_time) }] : [];
  });
  return { id: conv.id ?? conv.conversation_id ?? null, messages };
}
function parseClaude(raw: any, convId?: string): { id: string | null; messages: Omit<Msg, 'i'>[] } {
  const list = Array.isArray(raw) ? raw : [raw];
  const conv = convId ? list.find(c => c.uuid === convId) : list.length === 1 ? list[0] : null;
  if (!conv?.chat_messages) throw new RunnerFailure('INPUT', list.length > 1 && !convId ? 'Export has several conversations; pass --conversation-id' : 'Not a Claude conversation export (no chat_messages)');
  const messages = conv.chat_messages.flatMap((m: any) => {
    const text = (typeof m.text === 'string' && m.text.trim() ? m.text : (m.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')).trim();
    if (!text || (m.sender !== 'human' && m.sender !== 'assistant')) return [];
    return [{ speaker: m.sender === 'human' ? 'owner' : 'model', text, at: iso(m.created_at) }];
  });
  return { id: conv.uuid ?? null, messages };
}
function parseClaudeCode(raw: string): Omit<Msg, 'i'>[] {
  const out: Omit<Msg, 'i'>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { throw new RunnerFailure('INPUT', 'Claude Code transcript lines must be JSON'); }
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isMeta || e.isSidechain) continue;
    const c = e.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
    const clean = strip(text);
    if (clean) out.push({ speaker: e.type === 'user' ? 'owner' : 'model', text: clean, at: iso(e.timestamp) });
  }
  return out;
}

// ---------- import ----------
export function captureImport(workspaceArg: string, o: { file: string; host: string; format: string; authorization: string; title: string; visibility?: string; conversation_id?: string; from?: number; to?: number }) {
  const root = realpathSync(resolve(workspaceArg)); const cfg = captureConfig(root);
  if (!cfg.enabled) throw new RunnerFailure('PERMISSION', 'Conversation capture is not enabled for this workspace (studio-business.json capture.enabled)');
  if (!cfg.allowed_hosts.includes(o.host)) throw new RunnerFailure('PERMISSION', `Host "${o.host}" is not in capture.allowed_hosts`);
  if (typeof o.authorization !== 'string' || o.authorization.trim().length < 10) throw new RunnerFailure('PERMISSION', 'Capture needs --authorization with the owner\'s own words authorizing it');
  if (!(FORMATS as readonly string[]).includes(o.format)) throw new RunnerFailure('INPUT', `format must be one of ${FORMATS.join(', ')}`);
  if (typeof o.title !== 'string' || o.title.trim().length < 3) throw new RunnerFailure('INPUT', 'Capture needs a title');
  const vis = o.visibility ?? 'restricted'; if (vis !== 'restricted' && vis !== 'approved') throw new RunnerFailure('INPUT', 'visibility must be restricted or approved');
  const f = resolve(o.file); if (lstatSync(f).isSymbolicLink()) throw new RunnerFailure('PERMISSION', 'Transcript file is a symlink');
  const bytes = readFileSync(f); if (bytes.length > 20_000_000) throw new RunnerFailure('INPUT', 'Transcript exceeds 20 MB');
  const raw = bytes.toString('utf8');
  let parsed: { id: string | null; messages: Omit<Msg, 'i'>[] };
  const json = () => { try { return JSON.parse(raw); } catch { throw new RunnerFailure('INPUT', `${o.format} input is not valid JSON`); } };
  if (o.format === 'text') parsed = { id: o.conversation_id ?? null, messages: parseText(raw) };
  else if (o.format === 'chatgpt-export') parsed = parseChatGpt(json(), o.conversation_id);
  else if (o.format === 'claude-export') parsed = parseClaude(json(), o.conversation_id);
  else if (o.format === 'claude-code-jsonl') parsed = { id: o.conversation_id ?? null, messages: parseClaudeCode(raw) };
  else {
    const j = json();
    if (j?.schema_version !== 'studio.transcript/0.1' || !Array.isArray(j.messages)) throw new RunnerFailure('INPUT', 'studio format needs schema_version studio.transcript/0.1 and messages[]');
    parsed = { id: j.conversation_id ?? o.conversation_id ?? null, messages: j.messages.map((m: any) => { if (!['owner', 'model', 'other'].includes(m.speaker) || typeof m.text !== 'string') throw new RunnerFailure('INPUT', 'studio messages need speaker owner|model|other and text'); return { speaker: m.speaker, text: m.text, at: iso(m.at) }; }) };
  }
  const from = o.from ?? 1, to = o.to ?? parsed.messages.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new RunnerFailure('INPUT', 'from/to must be a valid 1-based message range');
  let msgs = parsed.messages.slice(from - 1, to);
  if (!msgs.length) throw new RunnerFailure('INPUT', 'No owner or model messages found in the selected range');
  const redactions: Record<string, number> = {};
  const redact = (t: string) => redactText(t, cfg.redact, redactions);
  const messages: Msg[] = msgs.map((m, k) => ({ i: k + 1, speaker: m.speaker, text: redact(m.text), at: m.at }));
  const content_sha256 = hash(JSON.stringify(messages));
  const id = `cap-${content_sha256.slice(0, 12)}`;
  const idx = loadIndex(root);
  if (idx.some(e => e.content_sha256 === content_sha256)) throw new RunnerFailure('INPUT', `Duplicate import: this exact conversation content is already captured as ${idx.find(e => e.content_sha256 === content_sha256)!.capture_id}`);
  const prior = parsed.id ? idx.find(e => e.host === o.host && e.conversation_id === parsed.id && !e.superseded_by) : undefined;
  const rec = { schema_version: 'studio.capture/0.1', capture_id: id, host: o.host, format: o.format, title: redactText(o.title.trim(), cfg.redact), conversation_id: parsed.id, source_file: basename(f), source_sha256: hash(bytes), range: { from, to, of: parsed.messages.length },
    imported_at: now(), authorization: { quote: o.authorization.trim(), authenticated: false }, visibility: vis, redactions, supersedes: prior?.capture_id ?? null,
    evidence_status: 'conversation record: not evidence; model statements are not verified facts; nothing here is a permitted public claim', content_sha256, messages };
  atomicWrite(join(capDir(root, id), 'transcript.json'), JSON.stringify(rec, null, 2));
  atomicWrite(anchorPath(root, id), JSON.stringify(anchor(rec)));
  if (prior) prior.superseded_by = id;
  idx.push({ capture_id: id, host: o.host, conversation_id: parsed.id, title: rec.title, content_sha256, imported_at: rec.imported_at, visibility: vis, superseded_by: null });
  atomicWrite(join(root, 'captures', 'index.json'), JSON.stringify(idx, null, 2));
  return { capture_id: id, messages: messages.length, owner_messages: messages.filter(m => m.speaker === 'owner').length, redactions, supersedes: rec.supersedes, visibility: vis };
}
/** Classification anchor kept outside captures/ (in .studio/), so flipping visibility needs more than editing transcript.json + index.json. A local-FS writer can still rewrite both. */
const anchorPath = (root: string, id: string) => join(root, '.studio', 'capture-anchors', `${id}.json`);
const anchor = (t: { capture_id: string; visibility: string; host: string; content_sha256: string }) => ({ capture_id: t.capture_id, visibility: t.visibility, sha256: hash(JSON.stringify([t.capture_id, t.visibility, t.host, t.content_sha256])) });
type IndexEntry = { capture_id: string; host: string; conversation_id: string | null; title: string; content_sha256: string; imported_at: string; visibility: string; superseded_by: string | null };
/** Parse a capture-store file without ever quoting its content in the error. */
function readJson(f: string): any { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { throw new RunnerFailure('SOURCE', 'A capture store file is not valid JSON; re-import or restore it'); } }
function loadIndex(root: string): IndexEntry[] { const f = join(root, 'captures', 'index.json'); const x = existsSync(f) ? readJson(f) : []; if (!Array.isArray(x)) throw new RunnerFailure('SOURCE', 'The capture index is invalid'); return x; }
const recordAnchor = (root: string, id: string) => join(root, '.studio', 'capture-anchors', `${id}.record.json`);
/** record.json items are only trusted when the bytes match the hash written at annotate time (kept in .studio/) and have the expected shape. */
function loadRecord(root: string, id: string, transcriptSha: string): { items: any[] } | null {
  const f = join(capDir(root, id), 'record.json'); if (!existsSync(f)) return null;
  const raw = readFileSync(f, 'utf8'); let anchorOk = false;
  try { const a = recordAnchor(root, id); anchorOk = existsSync(a) && !lstatSync(a).isSymbolicLink() && JSON.parse(readFileSync(a, 'utf8')).sha256 === hash(raw); } catch { /* unanchored */ }
  if (!anchorOk) throw new RunnerFailure('SOURCE', `Record for ${id} is not anchored or was changed after annotation; re-annotate`);
  let rec: any; try { rec = JSON.parse(raw); } catch { throw new RunnerFailure('SOURCE', `Record for ${id} is invalid`); }
  if (rec?.transcript_sha256 !== transcriptSha || !Array.isArray(rec.items) || rec.items.some((it: any) => !it || typeof it.id !== 'string' || typeof it.type !== 'string' || typeof it.text !== 'string' || typeof it.quote !== 'string' || !Number.isInteger(it.message) || typeof it.speaker !== 'string')) throw new RunnerFailure('SOURCE', `Record for ${id} does not match its transcript`);
  return rec;
}
/** Load a capture and prove it is unchanged since import. */
export function loadCapture(root: string, id: string) {
  const f = join(capDir(root, id), 'transcript.json');
  if (!existsSync(f)) throw new RunnerFailure('NOT_FOUND', `No capture ${id} in this workspace`);
  const t = readJson(f);
  if (!t || !Array.isArray(t.messages) || typeof t.content_sha256 !== 'string' || hash(JSON.stringify(t.messages)) !== t.content_sha256 || `cap-${t.content_sha256.slice(0, 12)}` !== id) throw new RunnerFailure('SOURCE', `Capture ${id} was changed after import; re-import it`);
  const entry = loadIndex(root).find(e => e.capture_id === id);
  if (!entry || !['approved', 'restricted'].includes(entry.visibility) || entry.visibility !== t.visibility || entry.content_sha256 !== t.content_sha256 || entry.host !== t.host) throw new RunnerFailure('SOURCE', `Capture ${id} classification or provenance changed after import`);
  // No matching anchor (legacy import, or visibility edited): treat as restricted.
  const a = anchorPath(root, id); let anchored = false;
  try { anchored = existsSync(a) && !lstatSync(a).isSymbolicLink() && JSON.parse(readFileSync(a, 'utf8')).sha256 === anchor(t).sha256; } catch { /* unanchored */ }
  if (!anchored) t.visibility = 'restricted';
  return t as { capture_id: string; host: string; title: string; visibility: string; messages: Msg[]; content_sha256: string };
}

// ---------- structured record ----------
/** The host Director proposes items; every quote must be verbatim from the attributed message. Decisions must be the owner's. */
export function captureAnnotate(workspaceArg: string, id: string, file: string, annotatedBy: string) {
  const root = realpathSync(resolve(workspaceArg)); const cfg = captureConfig(root);
  const t = loadCapture(root, id);
  if (!/^[a-z0-9-]+:[A-Za-z0-9_.-]+$/.test(annotatedBy)) throw new RunnerFailure('INPUT', 'annotated-by must look like host:tool');
  let raw: any; try { raw = JSON.parse(readFileSync(resolve(file), 'utf8')); } catch { throw new RunnerFailure('INPUT', 'Record file is not valid JSON'); }
  if (!Array.isArray(raw?.items) || !raw.items.length || raw.items.length > 200) throw new RunnerFailure('INPUT', 'Record needs items[] (1..200)');
  const items = raw.items.map((it: any, n: number) => {
    const where = `item ${n + 1}`;
    if (!(ITEM_TYPES as readonly string[]).includes(it?.type)) throw new RunnerFailure('INPUT', `${where}: type must be one of ${ITEM_TYPES.join(', ')}`);
    const m = t.messages.find(x => x.i === it.message); if (!m) throw new RunnerFailure('INPUT', `${where}: message ${it.message} does not exist`);
    if (typeof it.quote !== 'string' || it.quote.trim().length < 8 || !m.text.includes(it.quote)) throw new RunnerFailure('INPUT', `${where}: quote must be at least 8 characters copied verbatim from message ${it.message}`);
    if (it.speaker !== undefined && it.speaker !== m.speaker) throw new RunnerFailure('INPUT', `${where}: attributed to ${it.speaker}, but message ${it.message} is from ${m.speaker}`);
    if (typeof it.text !== 'string' || it.text.trim().length < 5) throw new RunnerFailure('INPUT', `${where}: text (a short paraphrase) is required`);
    if ((it.type === 'decision' || it.type === 'owner_question' || it.type === 'idea') && m.speaker !== 'owner') {
      const c = t.messages.find(x => x.i === it.confirmed_by_message);
      if (it.type !== 'decision' || !c || c.speaker !== 'owner' || c.i <= m.i) throw new RunnerFailure('INPUT', `${where}: a ${it.type} must come from the owner${it.type === 'decision' ? ', or name a later owner message that confirms it (confirmed_by_message)' : ''}`);
    }
    if (it.type === 'source_link' && !/https?:\/\/\S+/.test(it.quote)) throw new RunnerFailure('INPUT', `${where}: a source_link quote must contain the URL`);
    return { id: `ci-${n + 1}`, type: it.type, text: redactText(it.text.trim(), cfg.redact), quote: it.quote, message: m.i, speaker: m.speaker, at: m.at, related_to: it.related_to ?? null, confirmed_by_message: it.confirmed_by_message ?? null,
      evidence_status: m.speaker === 'model' ? 'model statement (not evidence)' : 'owner statement in conversation (not verified evidence)', public_claim_permitted: false, use: it.use === 'needs_evidence' ? 'needs_evidence' : 'internal_idea' };
  });
  for (const it of items) if (it.type === 'reason' && !items.some((d: any) => d.id === it.related_to && d.type === 'decision')) throw new RunnerFailure('INPUT', `${it.id}: a reason needs related_to pointing at a decision item`);
  const record = { schema_version: 'studio.capture-record/0.1', capture_id: id, transcript_sha256: t.content_sha256, annotated_by: annotatedBy, annotated_at: now(), items };
  const recordText = JSON.stringify(record, null, 2);
  atomicWrite(join(capDir(root, id), 'record.json'), recordText);
  atomicWrite(recordAnchor(root, id), JSON.stringify({ capture_id: id, sha256: hash(recordText) }));
  return { capture_id: id, items: items.length, by_type: items.reduce((a: Record<string, number>, x: any) => (a[x.type] = (a[x.type] ?? 0) + 1, a), {}) };
}

// ---------- retrieval ----------
/** Passages for context search: record items first, then single messages. Superseded or tampered captures are skipped. */
export function capturePassages(root: string): { passages: { id: string; path: string; visibility: string; heading: string; text: string }[]; warnings: string[] } {
  const passages: any[] = [], warnings: string[] = [];
  const dir = join(root, 'captures'); if (!existsSync(dir)) return { passages, warnings };
  for (const e of loadIndex(root).filter(x => !x.superseded_by)) {
    let t; try { t = loadCapture(root, e.capture_id); } catch (err) { warnings.push(err instanceof Error ? err.message : String(err)); continue; }
    if (t.visibility !== 'approved') continue;
    let rec: { items: any[] } | null = null;
    try { rec = loadRecord(root, e.capture_id, t.content_sha256); } catch (err) { warnings.push(err instanceof Error ? err.message : String(err)); }
    const label = (sp: string) => `conversation record (${sp}), ${t.visibility}: not evidence`;
    if (rec) for (const it of rec.items) passages.push({ id: `${e.capture_id}#${it.id}`, path: `captures/${e.capture_id}/record.json`, visibility: label(it.speaker), heading: `${it.type} (${t.title}, message ${it.message}${typeof it.at === 'string' ? ', ' + it.at.slice(0, 10) : ''})`, text: `${it.text}\n"${it.quote}"` });
    for (const m of t.messages) passages.push({ id: `${e.capture_id}#m${m.i}`, path: `captures/${e.capture_id}/transcript.json`, visibility: label(m.speaker), heading: `message ${m.i} (${t.title}${typeof m.at === 'string' ? ', ' + m.at.slice(0, 10) : ''})`, text: m.text.slice(0, 4000) });
  }
  return { passages, warnings };
}
export function captureList(workspaceArg: string) { const root = realpathSync(resolve(workspaceArg)); captureConfig(root); return loadIndex(root).map(e => {
  try { if (e.visibility === 'approved' && loadCapture(root, e.capture_id).visibility === 'approved') return e; } catch { /* Do not disclose metadata from an inconsistent record. */ }
  return { capture_id: e.capture_id, visibility: 'restricted', imported_at: e.imported_at, superseded_by: e.superseded_by };
}); }
/** One item or message with its neighbours, for the Director to read in context. */
export function captureShow(workspaceArg: string, id: string, ref: string) {
  const root = realpathSync(resolve(workspaceArg)); captureConfig(root); const t = loadCapture(root, id);
  if (t.visibility !== 'approved') throw new RunnerFailure('PERMISSION', 'Restricted capture cannot be shown to a host without scoped authorization');
  let at: number;
  if (/^ci-\d+$/.test(ref)) { const it = loadRecord(root, id, t.content_sha256)?.items.find((x: any) => x.id === ref); if (!it) throw new RunnerFailure('NOT_FOUND', `No item ${ref}`); at = it.message; }
  else if (/^m\d+$/.test(ref)) at = Number(ref.slice(1)); else throw new RunnerFailure('INPUT', 'ref must be ci-<n> or m<n>');
  return { capture_id: id, title: t.title, host: t.host, visibility: t.visibility, note: 'Conversation record, not evidence.', messages: t.messages.filter(m => Math.abs(m.i - at) <= 1).map(m => ({ ...m, text: m.text.slice(0, 6000) })) };
}
export function listCaptureDirs(root: string) { return existsSync(join(root, 'captures')) ? readdirSync(join(root, 'captures')).filter(x => x.startsWith('cap-')) : []; }
