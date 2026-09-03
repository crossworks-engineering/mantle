/**
 * The closure every registrar shares: the server handle, the owner id, the
 * response-hygiene helpers, and the builtin bridge.
 *
 * registerMantleTools was one 921-line function whose helpers were captured
 * lexically by every registration in it. Each registrar now destructures this
 * context, so the moved bodies keep the exact identifiers they had and are
 * byte-identical to what they replaced.
 *
 * `registerBuiltinTools` used to be declared 400 lines BELOW its first call
 * site, reachable only through hoisting. It is a definition now, not a
 * surprise.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkToolPreconditions } from '@mantle/tools';
import type { BuiltinToolDef } from '@mantle/tools';
import { env } from '@mantle/config';
import { zodShapeFromJsonSchema } from './zod-schema';
import type { MantleMcpTransport } from '../build-server';

export function makeRegisterContext(
  server: McpServer,
  ownerId: string,
  transport: MantleMcpTransport,
) {
  // Explicit env wins in both directions: =1 opts a network surface in, =0 opts
  // a local one out. Unset means stdio yes, HTTP no.
  const terminalEnv = env('MANTLE_MCP_TERMINAL') ?? '';
  const exposeTerminal = /^(1|true|on|yes)$/i.test(terminalEnv)
    ? true
    : /^(0|false|off|no)$/i.test(terminalEnv)
      ? false
      : transport === 'stdio';
  // ─── response hygiene ───────────────────────────────────────────────────────
  // MCP tool results are serialised straight into the model's context, so they
  // must NOT leak raw DB internals. A `select()` row carries `embedding` (768
  // floats ≈ 9 KB) and `searchTsv` (the full tsvector ≈ 50 KB on a big doc) —
  // pure noise to a reader that blows the context budget (a single `search` hit
  // measured 125 KB, an `entity_search` for one name 76 KB, ~98% vectors). Strip
  // those keys from every row before it goes out. See docs/recall-eval.md and the
  // audit that motivated this.
  const STRIP_KEYS = new Set(['embedding', 'searchTsv', 'search_tsv']);
  function stripVectors<T>(value: T): T {
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
  function jsonReply(value: unknown) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(stripVectors(value), null, 2) }],
    };
  }

  /** Lean projection of a node for list/search results: the "spine" (title, tags,
   *  summary), never the full body (`data.content`) or the index internals. Use
   *  node_read / file_read to fetch a body on demand. Mirrors the in-process
   *  `search_nodes` builtin so the two tool surfaces don't drift. */
  function leanNode(n: {
    id: string;
    type: string;
    title: string;
    path: string | null;
    tags: string[] | null;
    data: unknown;
    updatedAt: Date;
  }) {
    const data = (n.data ?? {}) as Record<string, unknown>;
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      path: n.path,
      tags: n.tags,
      summary: typeof data.summary === 'string' ? data.summary : null,
      updatedAt: n.updatedAt instanceof Date ? n.updatedAt.toISOString() : n.updatedAt,
    };
  }

  /** Bridge a set of in-app `BuiltinToolDef`s onto the MCP server, reusing the
   *  exact same handlers the in-app agent runs so the two surfaces never drift.
   *  Handlers get the minimal context `{ ownerId }` — every other `ctx` field
   *  (`step`, `surface`, `agent`) is optional and the handler degrades on its
   *  own (e.g. a worker tool that needs a Telegram chat refuses cleanly here).
   *  Binary `artifacts` are dropped (MCP results are text/JSON); tools that also
   *  persist their output to a node — e.g. `generate_image` → /files — still
   *  surface the node id in `output`.
   *
   *  `opts.skip` gates a def out; `opts.only` restricts to an explicit slug set,
   *  which is how a group is bridged for DEDUPLICATION without also widening the
   *  MCP surface with its other members. */
  function registerBuiltinTools(
    defs: readonly BuiltinToolDef[],
    opts?: { skip?: (def: BuiltinToolDef) => boolean; only?: ReadonlySet<string> },
  ) {
    for (const def of defs) {
      if (opts?.only && !opts.only.has(def.slug)) continue;
      if (opts?.skip?.(def)) continue;
      server.tool(
        def.slug,
        def.description,
        zodShapeFromJsonSchema(def.inputSchema),
        async (args: Record<string, unknown>) => {
          const input = args ?? {};
          // Declared referential preconditions run first, exactly as
          // dispatch.ts does for the in-app agent. Without this the MCP surface
          // is the only one where an id pointing at a missing — or wrong-type —
          // node reaches the handler and comes back as a bare "not found",
          // hiding the actual mistake.
          if (def.preconditions?.length) {
            const failure = await checkToolPreconditions(def.preconditions, input, ownerId);
            if (failure && !failure.ok) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${failure.error}` }],
                isError: true,
              };
            }
          }
          const result = await def.handler(input, { ownerId: ownerId });
          if (!result.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
              isError: true,
            };
          }
          return jsonReply(result.output);
        },
      );
    }
  }

  return {
    server,
    ownerId,
    transport,
    exposeTerminal,
    stripVectors,
    jsonReply,
    leanNode,
    registerBuiltinTools,
  };
}

/** What every register/*.ts module receives. */
export type McpRegisterContext = ReturnType<typeof makeRegisterContext>;
