// studio-bridge: newline-delimited MCP JSON-RPC on stdio -> POST http://127.0.0.1:<port>/mcp.
// A dumb pipe. Every auth, authority and tool decision stays in the Studio Service; this file only
// adds the bearer header, refuses non-loopback targets and never prints the token.
// Plain JS and Node stdlib only, so Claude Desktop's bundled Node runs it without flags.
// Env: STUDIO_TOKEN (required), STUDIO_PORT (default 8765), STUDIO_BRIDGE_URL (optional override, still loopback-only).

const MAX_LINE = 1024 * 1024; // the Service itself caps requests at 64 KiB; this only bounds our buffer
const CALL_TIMEOUT_MS = 300_000;

/** Only http://127.0.0.1[:port]/mcp, the one Host the Service accepts. No DNS, no userinfo, no redirects. */
export function loopbackUrl(env) {
  const raw = env.STUDIO_BRIDGE_URL || `http://127.0.0.1:${env.STUDIO_PORT || '8765'}/mcp`;
  let u;
  try { u = new URL(raw); } catch { throw new Error('Studio URL is not valid'); }
  const port = Number(u.port || 80);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || !Number.isInteger(port) || port < 1 || port > 65535 || u.pathname !== '/mcp' || u.search || u.hash) {
    throw new Error('Refusing: the Studio URL must be http://127.0.0.1:<port>/mcp');
  }
  return u.href;
}

const rpcError = (id, message) => JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } });

export function main(env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr) {
  const token = (env.STUDIO_TOKEN || '').trim();
  let url;
  try { url = loopbackUrl(env); } catch (e) { stderr.write(`studio-bridge: ${e.message}\n`); return 2; }
  if (!token) { stderr.write('studio-bridge: set the Studio token in the extension settings\n'); return 2; }

  const pending = new Set();
  const stop = new AbortController();
  let closing = false;

  async function forward(line) {
    let id = null;
    try { id = JSON.parse(line)?.id ?? null; } catch { /* the Service will answer the malformed line */ }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: line,
        redirect: 'error',
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
      });
      const text = await res.text();
      if (res.status === 202) return; // notification accepted, nothing to relay
      if (res.status === 200) { stdout.write(JSON.stringify(JSON.parse(text)) + '\n'); return; }
      // Never relay a body here: report only the status. 401 means the token in the extension settings is wrong.
      stdout.write(rpcError(id, res.status === 401 ? 'Studio Service rejected the token (401). Check the token in the extension settings.' : `Studio Service answered HTTP ${res.status}`) + '\n');
    } catch (e) {
      if (closing) return;
      stdout.write(rpcError(id, e?.name === 'TimeoutError' ? 'Studio Service timed out' : 'Cannot reach the Studio Service. Is it running on this laptop?') + '\n');
    }
  }

  let buf = '', skipping = false;
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (skipping) { skipping = false; continue; }
      if (!line.trim()) continue;
      const p = forward(line).finally(() => pending.delete(p));
      pending.add(p);
    }
    if (buf.length > MAX_LINE) { stdout.write(rpcError(null, 'Request too large') + '\n'); skipping = true; buf = ''; }
  });
  // Client closed stdin: finish in-flight calls, then exit (open keep-alive sockets must not hold us up).
  stdin.on('end', async () => { closing = true; await Promise.allSettled([...pending]); process.exit(0); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { closing = true; stop.abort(); process.exit(0); });
  return 0;
}

// Entry-point check on real paths: import.meta.url is always the resolved path, so a symlinked install path must be resolved too.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const code = main();
  if (code) process.exit(code);
}
