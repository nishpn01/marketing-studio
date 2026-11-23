/** In-process tool boundary. The embedding application must authenticate and select the workspace. */
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBusiness, contextSearch, sessionStart, sessionStatus } from './director-session.ts';
import { captureList, captureShow } from './conversation-capture.ts';
import { improvementList } from './improvement.ts';

const tools = {
  session_status: { description: 'Inspect saved sessions (state and counts only).', properties: { session: { type: 'string' } }, required: [] },
  context_search: { description: 'Search authorized context, labelled as guidance or conversation.', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] },
  improvement_list: { description: 'List saved improvement proposals.', properties: { session: { type: 'string' } }, required: [] },
  capture_list: { description: 'List available conversation captures.', properties: {}, required: [] },
  capture_show: { description: 'Read a bounded item from an approved capture.', properties: { capture: { type: 'string' }, ref: { type: 'string' } }, required: ['capture', 'ref'] },
  session_start: { description: 'Create a new discussion session.', properties: { idea: { type: 'string' }, slug: { type: 'string' } }, required: ['idea'] },
} as const;
export type LocalToolName = keyof typeof tools;
const names = Object.keys(tools) as LocalToolName[];
/** Field allowlist: no owner idea text, evidence/note/package paths or direction prose crosses this boundary. */
const minimalStatus = (s: ReturnType<typeof sessionStatus>[number]) => ({ session: s.session, state: s.state, evidence_count: s.evidence.length, restricted_evidence_count: s.evidence.filter(e => e.endsWith('(restricted)')).length, notes_count: s.notes.length,
  direction_approved: s.direction !== null, run: s.run ? { status: s.run.status, version: s.run.version, open_blockers: s.run.blockers.length } : null });
const slug = /^[a-z0-9][a-z0-9-]{2,60}$/;

/** No transport, credentials, account linking, model calls, approval, or publication. */
export function createLocalTools(workspace: string, allowed: readonly LocalToolName[]) {
  const root = realpathSync(resolve(workspace));
  if (!statSync(root).isDirectory()) throw new Error('Invalid workspace');
  loadBusiness(root);
  if (!Array.isArray(allowed) || allowed.some(n => !names.includes(n))) throw new Error('Invalid tool policy');
  const policy = new Set(allowed);
  return {
    list() {
      return names.filter(n => policy.has(n)).map(name => ({ name, description: tools[name].description,
        inputSchema: { type: 'object', properties: structuredClone(tools[name].properties), required: [...tools[name].required], additionalProperties: false } }));
    },
    call(raw: unknown): { ok: true; result: unknown } | { ok: false; error: 'INVALID_REQUEST' | 'DENIED' | 'OPERATION_FAILED' } {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'INVALID_REQUEST' };
      const request = raw as Record<string, unknown>;
      if (Object.keys(request).some(k => !['schema_version', 'name', 'arguments'].includes(k)) || request.schema_version !== 'studio.tool-call/0.1' || typeof request.name !== 'string' || !names.includes(request.name as LocalToolName) || !request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) return { ok: false, error: 'INVALID_REQUEST' };
      const name = request.name as LocalToolName;
      if (!policy.has(name)) return { ok: false, error: 'DENIED' };
      const args = request.arguments as Record<string, unknown>, spec = tools[name];
      if (Object.keys(args).some(k => !Object.hasOwn(spec.properties, k)) || (spec.required as readonly string[]).some(k => !Object.hasOwn(args, k))) return { ok: false, error: 'INVALID_REQUEST' };
      if (Object.entries(args).some(([k, v]) => k === 'limit' ? !Number.isInteger(v) || (v as number) < 1 || (v as number) > 20 : typeof v !== 'string' || v.length > (k === 'idea' ? 4000 : 300))) return { ok: false, error: 'INVALID_REQUEST' };
      if ((args.session !== undefined && !slug.test(args.session as string)) || (args.slug !== undefined && !slug.test(args.slug as string)) || (args.capture !== undefined && !/^cap-[0-9a-f]{12}$/.test(args.capture as string)) || (args.ref !== undefined && !/^(?:ci-\d+|m\d+)$/.test(args.ref as string))) return { ok: false, error: 'INVALID_REQUEST' };
      try {
        switch (name) {
          case 'session_status': return { ok: true, result: sessionStatus(root, args.session as string | undefined).map(minimalStatus) };
          case 'context_search': return { ok: true, result: contextSearch(root, args.query as string, args.limit as number | undefined) };
          case 'improvement_list': return { ok: true, result: improvementList(root, args.session as string | undefined) };
          case 'capture_list': return { ok: true, result: captureList(root) };
          case 'capture_show': return { ok: true, result: captureShow(root, args.capture as string, args.ref as string) };
          case 'session_start': return { ok: true, result: sessionStart(root, args.idea as string, args.slug as string | undefined) };
        }
      } catch { return { ok: false, error: 'OPERATION_FAILED' }; }
    },
  };
}
