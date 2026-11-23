/**
 * Minimal LOCAL stdio MCP server (JSON-RPC 2.0, newline-delimited) over createLocalTools.
 * Workspace and tool allowlist are fixed by CLI args at process start, never by requests.
 * No network, no HTTP, no auth: whoever can spawn this process has the access it was started with.
 */
import { createLocalTools } from './local-tools.ts';
import type { LocalToolName } from './local-tools.ts';
import { pathToFileURL } from 'node:url';

export const MAX_LINE = 64 * 1024;
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const err = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Returns the response object, or null for notifications. Never includes local exception text. */
export function handle(tools: ReturnType<typeof createLocalTools>, line: string): object | null {
  let m: any;
  try { m = JSON.parse(line); } catch { return err(null, -32700, 'Parse error'); }
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.jsonrpc !== '2.0' || typeof m.method !== 'string' || !(m.id === undefined || typeof m.id === 'string' || typeof m.id === 'number')) return err(null, -32600, 'Invalid request');
  const id = m.id; if (id === undefined) return null; // notification
  const p = m.params && typeof m.params === 'object' && !Array.isArray(m.params) ? m.params : {};
  switch (m.method) {
    case 'initialize': return { jsonrpc: '2.0', id, result: { protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'marketing-studio-local', version: '0.1.0' } } };
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: tools.list() } };
    case 'tools/call': {
      if (typeof p.name !== 'string' || (p.arguments !== undefined && (typeof p.arguments !== 'object' || p.arguments === null || Array.isArray(p.arguments)))) return err(id, -32602, 'Invalid params');
      const r = tools.call({ schema_version: 'studio.tool-call/0.1', name: p.name, arguments: p.arguments ?? {} });
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r.ok ? r.result : { error: r.error }) }], isError: !r.ok } };
    }
    default: return err(id, -32601, 'Method not found');
  }
}

export function parseArgs(argv: string[]): { workspace: string; allowed: LocalToolName[] } {
  const a = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const ws = a('--workspace'), t = a('--tools');
  if (!ws || !t) throw new Error('Usage: studio-mcp --workspace <dir> --tools <name,name,...>  (both required; no default tools)');
  return { workspace: ws, allowed: t.split(',').filter(Boolean) as LocalToolName[] };
}

export function serve(tools: ReturnType<typeof createLocalTools>, input = process.stdin, write = (s: string) => process.stdout.write(s)) {
  let buf = '', skipping = false;
  const out = (o: object | null) => { if (o) write(JSON.stringify(o) + '\n'); };
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (skipping) { skipping = false; continue; }
      if (line.trim()) out(line.length > MAX_LINE ? err(null, -32600, 'Request too large') : handle(tools, line));
    }
    if (buf.length > MAX_LINE) { if (!skipping) out(err(null, -32600, 'Request too large')); skipping = true; buf = ''; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let tools;
  try { const { workspace, allowed } = parseArgs(process.argv.slice(2)); tools = createLocalTools(workspace, allowed); }
  catch (e) { process.stderr.write(e instanceof Error && e.message.startsWith('Usage') ? e.message + '\n' : 'Cannot start: invalid workspace or tool policy\n'); process.exit(2); }
  serve(tools);
}
