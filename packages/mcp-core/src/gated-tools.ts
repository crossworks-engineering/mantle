/**
 * THE registration of the owner MCP surface. One function for every tool the
 * surface has: a builtin, a hand-written MCP definition (mcp-defs.ts), a
 * connector row of the login's workspaces. Listing equals calling:
 *
 *  - a tool is listed only when the one gate lists it for the connection
 *    (@mantle/db gateLists: its declared policy, the scope, the narrowers,
 *    the Admin step), by the ref it is called by;
 *  - a call runs through the one gate (enterCall): a builtin and a
 *    connector row through dispatch's gated path (the MCP caller of
 *    @mantle/tools gate-callers.ts), a definition's body directly. The gate
 *    enters the login's scope (mcp-scope.ts), names the create home (the
 *    connection's rule, gate-policy.ts), runs the pre-run checks (the
 *    surface's own first: the key email guard, a connector's workspace
 *    check and audit row; then the item pre-check and a key's or a peer's
 *    change to shared content) and maps a refusal (step 8).
 *
 * What stays here is the surface's own shape: the advertised schema (the
 * `workspace` argument of a create, create-home.ts withWorkspaceArg), the
 * reply (JSON with vectors stripped, a picture as an image block, a
 * refusal as `Error: ...`), and what is added to it after the call, in the
 * call's scope: the key email guard's list filter, and where a create
 * landed (withLanding). An error the call throws is answered as the
 * surface always has: a database error in the one mapper's words
 * (@mantle/tools thrownToolDatabaseError), any other by the SDK; a
 * connector row's own error as its reply text.
 *
 * It replaces the proxies that wrapped the server (filteredServer,
 * ownerScopedServer and runInOwnerMcpScope, createHomeServer), the
 * listing filter (preparedAllows), the builtin bridge's own checks
 * (callBuiltin), the catch in addTool and the connector's write check.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import {
  currentCaller,
  enterCall,
  gateLists,
  lookupPolicy,
  type GateCaller,
  type GatePolicy,
  type PolicyRef,
  type PreRunCheck,
  type Tool,
} from '@mantle/db';
import {
  dispatchTool,
  mcpBuiltinToolRef,
  mcpToolCaller,
  mcpVia,
  nestedToolCaller,
  thrownToolDatabaseError,
  type BuiltinToolDef,
  type ToolCaller,
  type ToolSurface,
} from '@mantle/tools';
import { toolInputSchema } from './register/tool-input';
import { zodShapeFromJsonSchema } from './register/zod-schema';
import { withModelImages } from './register/model-images';
import { refusalReply } from './refusal-reply';
import { WORKSPACE_ARG, withLanding, withWorkspaceArg } from './create-home';
import { toolAnnotations } from './tool-annotations';
import { logMcpCall } from './call-log';
// The `mcp-tool` policy source the listing and the calls read.
import './gate-policy';

/** What a registered tool's handler answers (the parts a guard reads). */
export type ToolCallResult = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [k: string]: unknown;
};

/** Checks around a registered tool's handler (the key email guard,
 *  key-email-guard.ts). `before`: a string refuses the call with that
 *  message, null lets it run; it runs first in the call's pre-run slot.
 *  `after`: what the caller gets back instead of the handler's answer (a
 *  list with rows dropped), in the call's scope. */
export type ToolCallGuard = {
  before?: (slug: string, args: Record<string, unknown>) => Promise<string | null>;
  after?: (
    slug: string,
    args: Record<string, unknown>,
    result: ToolCallResult,
  ) => Promise<ToolCallResult>;
};

/** One connection's side of the gate: who lists, who calls, and the
 *  surface's own checks. */
export type McpGate = Readonly<{
  /** The caller the listing reads (gateLists). */
  lists: GateCaller;
  /** The caller of one call of a tool with `policy`: the listing's for an
   *  HTTP connection (one request), read per call for stdio (the scope's
   *  Admin view now). */
  callerFor: (policy: GatePolicy) => Promise<GateCaller>;
  /** The key email guard (an API key without Search). */
  guard?: ToolCallGuard;
  /** A connector row's own check before it runs, and its audit row
   *  (login-surface.ts): the refusal, or null. */
  connector?: (row: Tool, args: Record<string, unknown>) => Promise<string | null>;
}>;

/** One tool of the surface. */
export type McpToolEntry =
  /** A builtin, under its own name, run on `surface`. */
  | { kind: 'builtin'; def: BuiltinToolDef; surface: ToolSurface }
  /** A hand-written MCP definition (mcp-defs.ts): its body for this
   *  connection. */
  | {
      kind: 'definition';
      name: string;
      description: string;
      shape: z.ZodRawShape;
      run: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
    }
  /** A connector row of the login's workspaces, run on `surface`. */
  | { kind: 'connector'; row: Tool; surface: ToolSurface };

// An MCP reply that refuses the call (its own module: no import cycle with
// gate-policy.ts).
export { refusalReply } from './refusal-reply';
import { errorMessage } from '@mantle/std';

// ── response hygiene ─────────────────────────────────────────────────────────
// MCP tool results are serialised straight into the model's context, so they
// must NOT leak raw DB internals. A `select()` row carries `embedding` (768
// floats ≈ 9 KB) and `searchTsv` (the full tsvector ≈ 50 KB on a big doc) —
// pure noise to a reader that blows the context budget (a single `search` hit
// measured 125 KB, an `entity_search` for one name 76 KB, ~98% vectors). Strip
// those keys from every row before it goes out. See docs/recall-eval.md and the
// audit that motivated this.
const STRIP_KEYS = new Set(['embedding', 'searchTsv', 'search_tsv']);

/** `value` with vectors and tsvectors stripped, at every depth. */
export function stripVectors<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripVectors(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_KEYS.has(k)) continue;
      out[k] = stripVectors(v);
    }
    return out as T;
  }
  return value;
}

/** Standard JSON tool reply, with vectors/tsvector stripped. */
export function jsonReply(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(stripVectors(value), null, 2) }],
  };
}

/** A builtin's row, as dispatch runs it: its own slug and handler ref. */
function builtinRow(def: BuiltinToolDef): Tool {
  return { slug: def.slug, handler: { kind: 'builtin', ref: def.slug } } as unknown as Tool;
}

/**
 * Run one builtin for an MCP call (`caller`: the call's, or one nested in
 * it) through dispatch's gated path, and shape its reply: the JSON output,
 * a picture the tool made for the caller as an image block after it
 * (draw_get with image), or the refusal. Throws what the call throws.
 */
export async function dispatchMcpBuiltin(
  def: BuiltinToolDef,
  args: Record<string, unknown>,
  opts: { ownerId: string; surface: ToolSurface; caller: ToolCaller },
): Promise<ToolCallResult> {
  const result = await dispatchTool(builtinRow(def), args, {
    ownerId: opts.ownerId,
    surface: opts.surface,
    caller: opts.caller,
  });
  if (!result.ok) return refusalReply(result.error);
  return withModelImages(jsonReply(result.output), result.modelImages);
}

/**
 * The caller of a builtin a definition's body runs (`search` runs
 * search_nodes): nested in the MCP call it serves (that call's caller, less
 * its own parts), else a call of its own on `gate`.
 */
export async function builtinCallerOn(gate: McpGate, def: BuiltinToolDef): Promise<ToolCaller> {
  const bound = currentCaller();
  if (bound && mcpVia(bound)) return nestedToolCaller(mcpToolCaller(bound));
  return mcpToolCaller(await gate.callerFor(lookupPolicy(mcpBuiltinToolRef(def.slug, def.slug))));
}

/** An error a connector row's own check threw: answered as a thrown call
 *  is (the SDK's words), not as the row's error text. */
class ConnectorCheckThrow extends Error {
  constructor(readonly thrown: unknown) {
    super('a connector check threw', { cause: thrown });
    this.name = 'ConnectorCheckThrow';
  }
}

/** The ref a tool is listed and called by. */
function refOf(entry: McpToolEntry): { name: string; ref: PolicyRef } {
  if (entry.kind === 'builtin') {
    return { name: entry.def.slug, ref: mcpBuiltinToolRef(entry.def.slug, entry.def.slug) };
  }
  if (entry.kind === 'connector') {
    return {
      name: entry.row.slug,
      ref: Object.freeze({ kind: 'runtime-tool', name: entry.row.slug, row: entry.row }),
    };
  }
  return { name: entry.name, ref: Object.freeze({ kind: 'mcp-tool', name: entry.name }) };
}

/** The surface's own pre-run check of one call of `entry`. */
function preRunOf(gate: McpGate, entry: McpToolEntry, name: string): PreRunCheck | undefined {
  if (entry.kind === 'connector') {
    const check = gate.connector;
    if (!check) return undefined;
    return async (_caller, _policy, ref, call) => {
      if (ref.kind !== 'runtime-tool') return null;
      try {
        return await check(entry.row, call.args ?? {});
      } catch (err) {
        throw new ConnectorCheckThrow(err);
      }
    };
  }
  const before = gate.guard?.before;
  if (!before) return undefined;
  return async (_caller, _policy, _ref, call) => before(name, call.args ?? {});
}

/**
 * Register `entry` on `server` for the connection `gate` describes, when
 * the gate lists it (see the module comment). Whether it was registered.
 */
export function registerGatedTool(
  server: McpServer,
  gate: McpGate,
  ownerId: string,
  entry: McpToolEntry,
): boolean {
  const { name, ref } = refOf(entry);
  if (!gateLists(gate.lists, ref)) return false;
  const policy = lookupPolicy(ref);
  // A create takes `workspace` and names where its item landed; on a
  // connection with no home for an item its creates are refused (gate step
  // 6) and take no `workspace`.
  const creates =
    entry.kind !== 'connector' && Boolean(policy.creates) && !gate.lists.createHome?.refuseCreates;
  const description =
    entry.kind === 'builtin'
      ? entry.def.description
      : entry.kind === 'connector'
        ? entry.row.description
        : entry.description;
  const shape =
    entry.kind === 'definition'
      ? entry.shape
      : zodShapeFromJsonSchema(
          ((entry.kind === 'builtin' ? entry.def.inputSchema : entry.row.inputSchema) ??
            {}) as Record<string, unknown>,
        );
  const schema = toolInputSchema(shape);
  const inputSchema = (creates ? withWorkspaceArg(schema) : schema) as typeof schema;
  const preRun = preRunOf(gate, entry, name);
  const after = entry.kind === 'connector' ? undefined : gate.guard?.after;

  const run = async (args: unknown, extra: unknown): Promise<unknown> => {
    const input = { ...((args ?? {}) as Record<string, unknown>) };
    const ask = creates ? { from: 'argument' as const, workspace: input[WORKSPACE_ARG] } : null;
    if (creates) delete input[WORKSPACE_ARG];
    const since = new Date(Date.now() - 1000);
    try {
      const base = await gate.callerFor(policy);
      const caller: GateCaller = preRun ? { ...base, preRun } : base;
      let reply: unknown;
      if (entry.kind === 'definition') {
        let thrown: { err: unknown } | null = null;
        const res = await enterCall(
          caller,
          ref,
          async () => {
            try {
              return await entry.run(input, extra);
            } catch (err) {
              thrown = { err };
              return null;
            }
          },
          // Its `workspace` argument (a create's, at step 6) and the owner
          // the pre-run checks read (the item pre-check, a key's change to
          // shared content), as a builtin's call names them: no definition creates or changes shared content today,
          // and one that does keeps both.
          { args: input, ask, context: { ownerId } },
        );
        if (thrown) throw (thrown as { err: unknown }).err;
        if (!res.ok) return refusalReply(res.refusal.toolText);
        reply = res.value;
      } else if (entry.kind === 'builtin') {
        reply = await dispatchMcpBuiltin(entry.def, input, {
          ownerId,
          surface: entry.surface,
          caller: mcpToolCaller(caller, ask),
        });
      } else {
        const result = await dispatchTool(entry.row, input, {
          ownerId,
          surface: entry.surface,
          caller: mcpToolCaller(caller),
        });
        if (!result.ok) return refusalReply(result.error);
        reply = withModelImages(jsonReply(result.output), result.modelImages);
      }
      if (!after && !creates) return reply;
      // What is added after the call, in its scope: the guard's list
      // filter, then where a create landed.
      const decorate = async () => {
        let out = reply as ToolCallResult;
        if (after) out = await after(name, input, out);
        return creates ? withLanding(out, since) : out;
      };
      return caller.enterScope ? await caller.enterScope(true, decorate) : await decorate();
    } catch (err) {
      const inner = err instanceof ConnectorCheckThrow ? err.thrown : err;
      const text = thrownToolDatabaseError(`mcp ${name}`, inner);
      if (text !== null) return refusalReply(text);
      // A connector row's own error is its reply's text, as it always was.
      if (entry.kind === 'connector' && !(err instanceof ConnectorCheckThrow)) {
        return refusalReply(errorMessage(err));
      }
      throw inner;
    }
  };
  // The MCP call log (Journal v3 J8): one row per call, here and only here,
  // for every tool, transport and login kind (call-log.ts). Shaped after the
  // reply and written fire and forget: it never changes or slows the call.
  const handler = async (args: unknown, extra: unknown): Promise<unknown> => {
    const started = performance.now();
    let reply: unknown = null;
    let thrown: unknown = null;
    let threw = false;
    try {
      reply = await run(args, extra);
      return reply;
    } catch (err) {
      threw = true;
      thrown = err;
      throw err;
    } finally {
      logMcpCall({
        loginId: gate.lists.loginId,
        via: gate.lists.via,
        tool: name,
        args,
        reply,
        thrown,
        threw,
        durationMs: performance.now() - started,
      });
    }
  };
  // The hints a client reads (tool-annotations.ts): advisory, the gate
  // above decides what runs.
  const annotations = toolAnnotations(entry, policy);
  server.registerTool(
    name,
    { description, inputSchema, ...(annotations ? { annotations } : {}) },
    handler as never,
  );
  return true;
}
