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
import type { BuiltinToolDef, OwnerSurfaceVia, ToolSurface } from '@mantle/tools';
import { env } from '@mantle/config';
import { zodShapeFromJsonSchema } from './zod-schema';
import { KEY_SHARED_CONTENT_TOOLS, contentToolTarget } from '../key-scope';
import { othersCanRead } from '../shared-item';
import type { MantleMcpTransport } from '../build-server';

/** The surface every bridged builtin runs under on the MCP server. */
export const MCP_OWNER_SURFACE: ToolSurface = { kind: 'owner', via: 'mcp' };

export function makeRegisterContext(
  server: McpServer,
  ownerId: string,
  transport: MantleMcpTransport,
  /** The owner path the builtins name: 'mcp', or 'federation' for a peer
   *  that acts as the owner (plan page e5b854dd). */
  via: OwnerSurfaceVia = 'mcp',
) {
  const surface: ToolSurface = via === 'mcp' ? MCP_OWNER_SURFACE : { kind: 'owner', via };
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

  // `leanNode` lived here: a hand-rolled node projection whose own comment said
  // it "mirrors the in-process search_nodes builtin so the two tool surfaces
  // don't drift". They drifted anyway — it never grew the `url` permalink or
  // the supersession annotation the builtin gained. Its only caller was the
  // `search` fork; `search` runs the builtin now, so the projection that was
  // supposed to track it is gone rather than left to rot again.

  /** Bridge a set of in-app `BuiltinToolDef`s onto the MCP server, reusing the
   *  exact same handlers the in-app agent runs so the two surfaces never drift.
   *  Handlers get the minimal context `{ ownerId, surface: owner/mcp }`; the
   *  other `ctx` fields (`step`, `agent`) are optional and the handler degrades
   *  on its own (e.g. a worker tool that needs a Telegram chat refuses cleanly here).
   *  Binary `artifacts` are dropped (MCP results are text/JSON); tools that also
   *  persist their output to a node — e.g. `generate_image` → /files — still
   *  surface the node id in `output`.
   *
   *  `opts.skip` gates a def out; `opts.only` restricts to an explicit slug set,
   *  which is how a group is bridged for DEDUPLICATION without also widening the
   *  MCP surface with its other members. */
  /** Run one builtin and shape its result as an MCP reply. Factored out of
   *  registerBuiltinTools so a tool registered under a DIFFERENT MCP name can
   *  still run the builtin through the identical path — preconditions, error
   *  mapping and response hygiene included. `search` is the case: the MCP
   *  surface has always called it `search`, the builtin is `search_nodes`, and
   *  the name mismatch is exactly why a hand-written fork of it survived every
   *  duplicate check we had. */
  async function callBuiltin(def: BuiltinToolDef, args: Record<string, unknown>) {
    const input = { ...(args ?? {}) };
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
    // The MCP caller holds the owner's credential: it names itself as the
    // owner (client logins C4), since a missing surface is not the owner.
    // A peer acting as the owner never confirms for the owner: a level
    // change it would cause (a move into a shared folder, a page filed in
    // one) is refused instead of confirmed by the caller's own flag.
    // An API key acting as the owner (via 'api') holds the same rule.
    if ((via === 'federation' || via === 'api') && 'confirm' in input) delete input.confirm;
    // And a key never changes the content of an item others can read: what
    // it embeds would become readable to them with no confirm (M2 audit N3).
    if (via === 'api' && KEY_SHARED_CONTENT_TOOLS.has(def.slug)) {
      const target = contentToolTarget(input);
      // The handler gets the very id that was checked (trimmed): a padded id
      // must not pass the check as "not found" and then reach the item
      // (final audit F1). A field that is not a UUID is refused outright.
      if (target?.id) input[target.field] = target.id;
      if (target && !target.id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${target.field} must be an item id (a UUID), as page_list or search_nodes give it.`,
            },
          ],
          isError: true,
        };
      }
      if (target?.id && (await othersCanRead(ownerId, target.id))) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: this item is shared, so an API key cannot change its content (what it embeds would become readable to others). Change it in the app.',
            },
          ],
          isError: true,
        };
      }
    }
    const result = await def.handler(input, { ownerId: ownerId, surface });
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }
    return jsonReply(result.output);
  }

  function registerBuiltinTools(
    defs: readonly BuiltinToolDef[],
    opts?: { skip?: (def: BuiltinToolDef) => boolean; only?: ReadonlySet<string> },
  ) {
    for (const def of defs) {
      if (opts?.only && !opts.only.has(def.slug)) continue;
      if (opts?.skip?.(def)) continue;
      server.tool(def.slug, def.description, zodShapeFromJsonSchema(def.inputSchema), (args) =>
        callBuiltin(def, args),
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
    registerBuiltinTools,
    callBuiltin,
  };
}

/** What every register/*.ts module receives. */
export type McpRegisterContext = ReturnType<typeof makeRegisterContext>;
