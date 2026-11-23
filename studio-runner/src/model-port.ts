/** ModelPort (RUNNER-CONTRACTS-v0.1 §2): one interface, provider-specific adapters. */
import { envOverride } from './env-override.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Role = 'director' | 'writer' | 'fact_reviewer' | 'craft_reviewer' | 'handoff_reader';
export type ModelRequest = { role: Role; model: string; system: string; prompt: string };
export type ModelResult = {
  text: string;
  provider: string;
  model_id: string;            // observed, not requested, where the provider reports it
  live: boolean;               // false = fixture output, never present as model work
  usage: { input_tokens: number | null; output_tokens: number | null; notional_cost_usd: number | null; billing: string; raw?: Record<string, number | undefined> | null };
  latency_ms: number;
  request_id: string | null;
};
export interface ModelPort { readonly provider: string; invoke(req: ModelRequest): ModelResult }

export class ProviderError extends Error { constructor(msg: string) { super(msg); this.name = 'ProviderError'; } }
export const CODEX_API_KEY_ENVS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY'] as const;
export const codexApiKeyEnv = () => CODEX_API_KEY_ENVS.find((name) => !!process.env[name]);

/** Deterministic scripted responses for tests. Output is labelled live:false everywhere it is stored. */
export class FixtureModel implements ModelPort {
  readonly provider = 'fixture';
  calls: ModelRequest[] = [];
  script: (req: ModelRequest, n: number) => string;
  constructor(script: (req: ModelRequest, n: number) => string) { this.script = script; }
  invoke(req: ModelRequest): ModelResult {
    this.calls.push(req);
    const text = this.script(req, this.calls.filter(c => c.role === req.role).length);
    return { text, provider: this.provider, model_id: 'fixture', live: false,
      usage: { input_tokens: null, output_tokens: null, notional_cost_usd: 0, billing: 'none' }, latency_ms: 0, request_id: null };
  }
}

/**
 * Claude Code headless CLI (`claude -p`) under the operator's own logged-in Claude Code account.
 * - Fails closed unless the local CLI reports a first-party claude.ai login; no separately billed API use.
 * - Does not forward unrelated environment variables or provider credentials to the child process.
 * - No tools, MCP, slash commands or setting sources; runs in an empty temp dir; no session persistence.
 *   The model therefore sees only the prompt the Runner builds from permitted sources.
 * - total_cost_usd is reported by the CLI; actual billing is not independently verified here.
 */
export class ClaudeCodeCliModel implements ModelPort {
  readonly provider = 'claude-code-cli';
  bin: string; timeoutMs: number;
  constructor(bin = envOverride('STUDIO_CLAUDE_BIN') || 'claude', timeoutMs = 600_000) { this.bin = bin; this.timeoutMs = timeoutMs; }
  invoke(req: ModelRequest): ModelResult {
    if (process.env.ANTHROPIC_API_KEY) throw new ProviderError('ANTHROPIC_API_KEY is set; refusing because it would bill API usage. Unset it to use the Claude Code login.');
    if (!/^[a-z0-9.-]{3,60}$/.test(req.model)) throw new ProviderError('Invalid model name');
    const cwd = mkdtempSync(join(tmpdir(), 'studio-model-'));
    const started = Date.now();
    try {
      const env: NodeJS.ProcessEnv = {};
      for (const k of ['PATH', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM', 'CLAUDE_CONFIG_DIR']) if (process.env[k] !== undefined) env[k] = process.env[k];
      const status = spawnSync(this.bin, ['auth', 'status', '--json'], { cwd, env, encoding: 'utf8', timeout: 15000, maxBuffer: 20000 });
      let auth: any; try { auth = JSON.parse(status.stdout); } catch { throw new ProviderError('Cannot verify Claude Code login; refusing model invocation'); }
      if (status.status !== 0 || auth.loggedIn !== true || auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty') throw new ProviderError('Claude Code did not report a first-party claude.ai login; refusing model invocation');
      const systemFile = join(cwd, 'system-prompt');
      writeFileSync(systemFile, req.system, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const out = spawnSync(this.bin, ['-p', '--output-format', 'json', '--model', req.model, '--tools', '',
        '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '',
        '--system-prompt-file', systemFile], { cwd, env, input: req.prompt, encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: 20_000_000 });
      if (out.error) throw new ProviderError('claude CLI unavailable: ' + out.error.message);
      let j: Record<string, any>;
      try { j = JSON.parse(out.stdout); } catch { throw new ProviderError(`claude CLI returned non-JSON (exit ${out.status}): ${(out.stderr || out.stdout).slice(0, 300)}`); }
      if (j.is_error || j.subtype !== 'success' || typeof j.result !== 'string') throw new ProviderError('claude CLI error: ' + String(j.result ?? j.subtype).slice(0, 300));
      const models = Object.keys(j.modelUsage || {});
      return { text: j.result, provider: this.provider, model_id: models.join(',') || req.model, live: true,
        usage: { input_tokens: j.usage ? (j.usage.input_tokens ?? 0) + (j.usage.cache_creation_input_tokens ?? 0) + (j.usage.cache_read_input_tokens ?? 0) : null, output_tokens: j.usage?.output_tokens ?? null,
          raw: j.usage ? { input_tokens: j.usage.input_tokens, cache_creation_input_tokens: j.usage.cache_creation_input_tokens, cache_read_input_tokens: j.usage.cache_read_input_tokens } : null,
          notional_cost_usd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null, billing: 'claude-code-cli reports claude.ai login; external billing not independently verified' },
        latency_ms: Date.now() - started, request_id: j.session_id ?? j.uuid ?? null };
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
}

/**
 * Codex CLI under the operator's logged-in ChatGPT subscription.
 * The current CLI has no general --no-tools flag, so shell and interactive integrations are
 * disabled explicitly; the process also runs read-only in a new empty directory.
 */
export class CodexCliModel implements ModelPort {
  readonly provider = 'codex-cli';
  bin: string; timeoutMs: number;
  constructor(bin = envOverride('STUDIO_CODEX_BIN') || 'codex', timeoutMs = 600_000) { this.bin = bin; this.timeoutMs = timeoutMs; }
  invoke(req: ModelRequest): ModelResult {
    const apiKey = codexApiKeyEnv();
    if (apiKey) throw new ProviderError(`${apiKey} is set; refusing because Codex must use the logged-in ChatGPT subscription, not API billing.`);
    if (!/^[a-z0-9.-]{3,60}$/.test(req.model)) throw new ProviderError('Invalid model name');
    const cwd = mkdtempSync(join(tmpdir(), 'studio-codex-'));
    const output = join(cwd, 'last-message');
    const started = Date.now();
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM', 'CODEX_HOME']) if (process.env[key] !== undefined) env[key] = process.env[key];
    try {
      const status = spawnSync(this.bin, ['login', 'status'], { cwd, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 20_000 });
      if (status.error || status.status !== 0) throw this.failure('Codex login check failed', status.error ?? Object.assign(new Error(status.stderr || status.stdout), { signal: status.signal }));
      const login = status.stdout + status.stderr;
      if (!/logged in using chatgpt/i.test(login)) throw new ProviderError('Codex did not report a ChatGPT subscription login; refusing model invocation');
      const prompt = `Generate only the requested text. Do not call tools, execute commands, browse, or access files.\n\n<System instructions>\n${req.system}\n</System instructions>\n\n<User prompt>\n${req.prompt}\n</User prompt>`;
      let events: string;
      try {
        events = execFileSync(this.bin, ['exec', '--model', req.model, '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'unified_exec_tty', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '--json', '--output-last-message', output], { cwd, env, input: prompt, encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: 20_000_000 });
      } catch (error) { throw this.failure('codex exec failed', error); }
      let outputStat;
      try { outputStat = statSync(output); } catch { throw new ProviderError('codex exec produced no output'); }
      if (!outputStat.isFile() || outputStat.size > 20_000_000) throw new ProviderError('codex exec output exceeds 20000000 bytes');
      const meta = this.metadata(events, req.model);
      return { text: readFileSync(output, 'utf8'), provider: this.provider, model_id: meta.model, live: true,
        usage: { input_tokens: meta.input, output_tokens: meta.output, notional_cost_usd: null, raw: meta.raw, billing: 'codex-cli reports a ChatGPT subscription login; external billing is not independently verified' },
        latency_ms: Date.now() - started, request_id: meta.requestId };
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
  private failure(prefix: string, error: unknown): ProviderError {
    const e = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer; signal?: string | null };
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') return new ProviderError(`${prefix}: timed out`);
    const detail = String(e.stderr ?? e.stdout ?? e.message ?? error).slice(0, 300);
    return new ProviderError(`${prefix}: ${detail}`);
  }
  private metadata(events: string, requested: string) {
    let requestId: string | null = null, model = requested, input: number | null = null, output: number | null = null;
    let raw: Record<string, number | undefined> | null = null;
    for (const line of events.split('\n')) {
      try {
        const event = JSON.parse(line) as { type?: string; thread_id?: unknown; model?: unknown; usage?: Record<string, unknown> };
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') requestId = event.thread_id;
        if (typeof event.model === 'string') model = event.model;
        if (event.type === 'turn.completed' && event.usage) {
          const n = (key: string) => typeof event.usage![key] === 'number' ? event.usage![key] as number : undefined;
          const cached = n('cached_input_tokens'), direct = n('input_tokens');
          input = direct === undefined ? null : direct + (cached ?? 0);
          output = n('output_tokens') ?? null;
          raw = { input_tokens: direct, cached_input_tokens: cached, output_tokens: n('output_tokens') };
        }
      } catch {}
    }
    return { requestId, model, input, output, raw };
  }
}

/** Explicit, fail-closed provider selection: only a named, vetted live adapter is ever constructed. No default, no fallback, no implicit paid access. */
export const LIVE_PROVIDERS = ['claude-code-cli', 'codex-cli'] as const;
export function modelFor(provider: string): ModelPort {
  if (provider === 'claude-code-cli') return new ClaudeCodeCliModel();
  if (provider === 'codex-cli') return new CodexCliModel();
  throw new ProviderError(`Unknown provider; live providers are: ${LIVE_PROVIDERS.join(', ')}. Tests inject FixtureModel directly`);
}

/** Strict JSON extraction: whole text, or a single fenced ```json block. No repair heuristics. */
export function parseJson(text: string): unknown {
  const t = text.trim();
  const m = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(t);
  return JSON.parse(m ? m[1] : t);
}
