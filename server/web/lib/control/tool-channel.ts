/**
 * The subject box's admin channel (docs/control-center.md, "The admin
 * channel"): two more fixed cases on the signed route (box.ts), so the
 * route's own checks hold them first and no agent, MCP client or API key
 * on the box reaches them.
 *
 *  - `tool { nonce, name, args }`, the nonce a one-time uuid: runs one of the box's
 *    own builtin tools through the one dispatcher (dispatchTool, the one
 *    gate), as a /api/v1 route runs one (lib/api-v1-builtin.ts): the
 *    brain's own surface, a process caller, the actor system(control:tool).
 *  - `tools`: the tools the box's scope allows, with their input schemas.
 *
 * The scope is the box's own `.env` line, MANTLE_CONTROL_CENTER_SCOPE
 * (env.ts controlScopeLine; owner decision 2026-11-12, admin by default):
 *  - absent: `admin`, so a linked box needs no third line;
 *  - `none`, or any other word (fails closed, named at boot): both cases
 *    are refused (`scope`), the fixed cases stay;
 *  - `admin`: the tools of the Admin areas settings, assistants and keys,
 *    the users area's reviewed tools (REVIEWED_USERS_TOOLS), and
 *    workspaces_list, less code and run execution (sandbox_*, run_*).
 *    The other areas hold data (email, peers, Telegram, recall) and stay
 *    out, as does every tool of no area (files, pages, tables, search);
 *  - `full`: every builtin.
 * Never, in any scope: a control_* tool (the Control Center's own; the
 * link is .env only), a whole-tool person-only act, the brain's own shell
 * (run_terminal: it reads the master key and writes .env). A Toolsmith write
 * only while the box keeps MANTLE_MCP_TOOLSMITH_WRITE on, as on its MCP. No builtin hands out a
 * vault value in plain text, and none writes a login row, so the owner is
 * out of reach (tool-channel.test.ts pins both). A `confirm` argument is
 * dropped: the Control Center is not a person, so it never confirms.
 *
 * A replay: the nonce is kept for NONCE_TTL_MS, longer than the signature's
 * window both ways, and a second use is refused. In memory: a box runs one
 * web process. Full (NONCE_MAX waiting): refused (fail closed).
 *
 * Caps: the args at most ARGS_MAX_CHARS of JSON; the answer's output at
 * most OUTPUT_MAX_CHARS of JSON, else its head as text, marked truncated.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { feature } from '@mantle/config';
import { controlScopeLine, type ControlScope } from './env';
import { WORKSPACE_AREAS, type WorkspaceArea } from '@mantle/client-types/dto/workspaces';
import { TtlCache } from '@mantle/std';
import { runAsSystem, type Tool } from '@mantle/db';
import {
  apiV1Caller,
  dispatchTool,
  getBuiltin,
  isPersonOnlyTool,
  listBuiltins,
  type BuiltinToolDef,
} from '@mantle/tools';

export type { ControlScope };

/** The box's scope for the admin channel, or null (none: refused). */
export function controlScope(): ControlScope | null {
  return controlScopeLine().scope;
}

/** The Admin areas whose tools are settings and management: every area
 *  but connectors (email, peers, Telegram); users only by name (below). */
const ADMIN_AREAS: ReadonlySet<string> = new Set(
  WORKSPACE_AREAS.filter((a: WorkspaceArea) => a !== 'connectors' && a !== 'users'),
);
/** A management read of no area. */
const ADMIN_EXTRA: ReadonlySet<string> = new Set(['workspaces_list']);
/**
 * The users area's tools, by name, each reviewed for the owner rule: it
 * never touches the box owner, never changes a role by itself (the Admin
 * workspace is refused: who is an Admin is a role), never sets a password
 * or makes a login. A users-area tool not named here stays out of `admin`
 * (and tool-channel.test.ts fails until it is reviewed). The Fleet users
 * screen's two (docs/control-center.md).
 */
export const REVIEWED_USERS_TOOLS: ReadonlySet<string> = new Set([
  'users_list',
  'workspace_user_set',
]);
/** Code and run execution, in an Admin area all the same. */
const NOT_ADMIN = /^(sandbox_|run_)/;
/** The Control Center's own tools: never through the channel. */
const NEVER = /^control_/;

function areaOf(def: BuiltinToolDef): string | null {
  const s = (def.policy as { scope?: unknown }).scope;
  return s && typeof s === 'object' && typeof (s as { area?: unknown }).area === 'string'
    ? (s as { area: string }).area
    : null;
}

/** Whether `scope` allows the builtin `def`. A tool the MCP surface offers
 *  only on the box's own opt-in stays as the box set it: the brain's own
 *  shell (`terminal`, a root shell with the master key and .env) never, and
 *  the Toolsmith writes only while MANTLE_MCP_TOOLSMITH_WRITE is on. */
export function toolAllowed(scope: ControlScope, def: BuiltinToolDef): boolean {
  if (NEVER.test(def.slug) || isPersonOnlyTool(def.slug)) return false;
  if (def.optIn === 'terminal') return false;
  if (def.optIn === 'toolsmithWrite' && !feature('mcpToolsmithWrite')) return false;
  if (scope === 'full') return true;
  if (NOT_ADMIN.test(def.slug)) return false;
  if (ADMIN_EXTRA.has(def.slug)) return true;
  const area = areaOf(def);
  if (area === 'users') return REVIEWED_USERS_TOOLS.has(def.slug);
  return area !== null && ADMIN_AREAS.has(area);
}

// --- the nonce ---------------------------------------------------------------

/** Longer than the signature's window (60 seconds either way). */
export const NONCE_TTL_MS = 150_000;
export const NONCE_MAX = 10_000;
let clock = () => Date.now();
const seen = new TtlCache<string, true>({ ttlMs: NONCE_TTL_MS, now: () => clock() });

/** Takes `nonce` once: 'ok', a second use 'replay', a full store 'busy'
 *  (never an eviction: a nonce leaves only once it is too old to sign). */
export function takeNonce(nonce: string, now = Date.now()): 'ok' | 'replay' | 'busy' {
  clock = () => now;
  const key = nonce.toLowerCase();
  if (seen.get(key)) return 'replay';
  if (seen.size >= NONCE_MAX) {
    seen.prune();
    if (seen.size >= NONCE_MAX) return 'busy';
  }
  seen.set(key, true);
  return 'ok';
}

/** Tests only. */
export function forgetNonces(): void {
  seen.clear();
}

// --- the calls ---------------------------------------------------------------

export const ARGS_MAX_CHARS = 32_000;
export const OUTPUT_MAX_CHARS = 64_000;
const OUTPUT_HEAD_CHARS = 8_000;
const ERROR_MAX_CHARS = 2_000;
const DESCRIPTION_MAX_CHARS = 600;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,79}$/;

/** The two cases, as box.ts's switch takes them. */
export const TOOL_CALLS = [
  z
    .object({
      op: z.literal('tool'),
      args: z
        .object({
          nonce: z.string().uuid(),
          name: z.string().regex(TOOL_NAME),
          args: z.record(z.string(), z.unknown()),
        })
        .strict(),
    })
    .strict(),
  z.object({ op: z.literal('tools'), args: z.object({}).strict().optional() }).strict(),
] as const;

export type ToolCall = z.infer<(typeof TOOL_CALLS)[0]>;

/** What a tool call answers. `reason`: scope (the scope is none), replay,
 *  busy, size (args too large), tool (not a tool this scope allows),
 *  refused (the tool said no: `error` is its own text), error (it threw:
 *  never its text). */
export type ToolAnswer = {
  name: string;
  ok: boolean;
  reason?: 'scope' | 'replay' | 'busy' | 'size' | 'tool' | 'refused' | 'error';
  output?: unknown;
  error?: string;
  truncated?: true;
};

function capped(output: unknown): { output: unknown; truncated?: true } {
  const text = JSON.stringify(output ?? null) ?? 'null';
  if (text.length <= OUTPUT_MAX_CHARS) return { output: output ?? null };
  return { output: text.slice(0, OUTPUT_HEAD_CHARS), truncated: true };
}

/** One `tool` call, as the anchor's brain. Never throws. */
export async function runToolCall(anchorId: string, call: ToolCall): Promise<ToolAnswer> {
  const { name, args } = call.args;
  const scope = controlScope();
  if (!scope) return { name, ok: false, reason: 'scope' };
  const nonce = takeNonce(call.args.nonce);
  if (nonce !== 'ok') return { name, ok: false, reason: nonce };
  if (Buffer.byteLength(JSON.stringify(args)) > ARGS_MAX_CHARS) {
    return { name, ok: false, reason: 'size' };
  }
  const def = getBuiltin(name);
  if (!def || !toolAllowed(scope, def)) return { name, ok: false, reason: 'tool' };
  const input = { ...args };
  delete input.confirm;
  const row = { slug: def.slug, handler: { kind: 'builtin', ref: def.slug } } as unknown as Tool;
  try {
    const result = await runAsSystem('control:tool', () =>
      dispatchTool(row, input, {
        ownerId: anchorId,
        surface: { kind: 'owner', via: 'api' },
        // Masked: a database error's text (its SQL, its params) never
        // leaves the box, as on an MCP call.
        caller: { ...apiV1Caller(), masks: true },
      }),
    );
    if (!result.ok) {
      return { name, ok: false, reason: 'refused', error: result.error.slice(0, ERROR_MAX_CHARS) };
    }
    return { name, ok: true, ...capped(result.output) };
  } catch {
    return { name, ok: false, reason: 'error' };
  }
}

/** One tool as the `tools` case lists it. */
export type ListedTool = {
  name: string;
  description: string;
  effect: string;
  inputSchema: Record<string, unknown>;
};

/** The `tools` case: the scope, and the tools it allows (none without one). */
export function listToolsForCenter(): { scope: ControlScope | null; tools: ListedTool[] } {
  const scope = controlScope();
  if (!scope) return { scope: null, tools: [] };
  const tools = listBuiltins()
    .filter((d) => toolAllowed(scope, d))
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((d) => ({
      name: d.slug,
      description: d.description.slice(0, DESCRIPTION_MAX_CHARS),
      effect: String((d.policy as { effect?: unknown }).effect ?? 'write'),
      inputSchema: d.inputSchema,
    }));
  return { scope, tools };
}

/** What a tool call's audit row names: the tool, ok or the reason, and a
 *  hash of the args, never the args nor the output. */
export function toolAuditDetail(call: ToolCall, answer: ToolAnswer): Record<string, unknown> {
  return {
    tool: call.args.name,
    ok: answer.ok,
    ...(answer.reason ? { reason: answer.reason } : {}),
    argsSha256: createHash('sha256').update(JSON.stringify(call.args.args)).digest('hex'),
  };
}

/** The scope a box declares, for a test of the lists. */
export function allowedToolNames(scope: ControlScope): string[] {
  return listBuiltins()
    .filter((d) => toolAllowed(scope, d))
    .map((d) => d.slug)
    .sort();
}
