/**
 * The closure every registrar shares: the server handle, the owner id, the
 * response-hygiene helpers, and the registration of builtins and
 * hand-written tools through the one gate (gated-tools.ts, A5 step 4).
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

import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { BuiltinToolDef, LoginMcpChannel, OwnerSurfaceVia, ToolSurface } from '@mantle/tools';
import { env } from '@mantle/config';
import { mcpDefinition } from '../mcp-defs';
import {
  builtinCallerOn,
  dispatchMcpBuiltin,
  jsonReply,
  registerGatedTool,
  stripVectors,
  type McpGate,
} from '../gated-tools';
import { defaultMcpGate } from '../gate-policy';
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
  /** The login of this connection (its OAuth consent, its API key, the
   *  login a peer is bound to), from the credential the route resolved
   *  (W6b fix round 2, M-2). Absent on stdio. */
  loginId?: string,
  /** The login's own connection (W7b): how it connected and its Write
   *  switch, for the app_data_* tools. Absent on stdio. */
  mcp?: LoginMcpChannel,
  /** The registration opt-ins the box holds besides the terminal (a
   *  definition's `optIn`): the Toolsmith writes (build-server.ts reads
   *  MANTLE_MCP_TOOLSMITH_WRITE once). Default on, as the env's default. */
  optIns: { toolsmithWrite: boolean } = { toolsmithWrite: true },
  /** The connection's side of the gate (registerPreparedTools builds it
   *  from the prepared connection). Absent: the anchor's own. */
  gate?: McpGate,
) {
  const surface: ToolSurface = via === 'mcp' ? MCP_OWNER_SURFACE : { kind: 'owner', via };
  // The handlers get the connection's login with it: who deletes an app
  // decides whether the trash keeps it for the owner (app_delete). The
  // channel goes with or without a login (W7b fix round 3): a peer bound to
  // an admin login that is not the owner's own peer has no loginId here,
  // and its `ownerKeysOff` must still reach the tools.
  const callSurface: ToolSurface = loginId
    ? { kind: 'owner', via, loginId, ...(mcp ? { mcp } : {}) }
    : mcp
      ? { kind: 'owner', via, mcp }
      : surface;
  // Explicit env wins in both directions: =1 opts a network surface in, =0 opts
  // a local one out. Unset means stdio yes, HTTP no.
  const terminalEnv = env('MANTLE_MCP_TERMINAL') ?? '';
  const exposeTerminal = /^(1|true|on|yes)$/i.test(terminalEnv)
    ? true
    : /^(0|false|off|no)$/i.test(terminalEnv)
      ? false
      : transport === 'stdio';
  // The connection's side of the gate (gated-tools.ts): what it lists,
  // who each call runs as. Absent: the anchor's own (stdio, the tests).
  const callGate: McpGate =
    gate ?? defaultMcpGate(loginId ?? ownerId, { transport, via, loginNamed: loginId });

  /** Run one builtin for this connection, through dispatch and the one
   *  gate (A5 step 4): the call of a hand-written tool that runs a builtin
   *  (`search` runs search_nodes), nested in that tool's own call. */
  async function callBuiltin(def: BuiltinToolDef, args: Record<string, unknown>) {
    return dispatchMcpBuiltin(
      def,
      { ...(args ?? {}) },
      {
        ownerId,
        surface: callSurface,
        caller: await builtinCallerOn(callGate, def),
      },
    );
  }

  /** Whether a definition's registration opt-in holds on this box. */
  function optedIn(def: { optIn?: BuiltinToolDef['optIn'] }): boolean {
    if (def.optIn === 'terminal') return exposeTerminal;
    if (def.optIn === 'toolsmithWrite') return optIns.toolsmithWrite;
    return true;
  }

  function registerBuiltinTools(
    defs: readonly BuiltinToolDef[],
    opts?: { skip?: (def: BuiltinToolDef) => boolean; only?: ReadonlySet<string> },
  ) {
    for (const def of defs) {
      if (opts?.only && !opts.only.has(def.slug)) continue;
      if (opts?.skip?.(def)) continue;
      // A builtin the surface defines itself under its name (a hand-written
      // MCP tool, mcp-defs.ts: its own schema and reply) is that definition's.
      if (mcpDefinition(def.slug)) continue;
      if (!optedIn(def)) continue;
      registerGatedTool(server, callGate, ownerId, { kind: 'builtin', def, surface: callSurface });
    }
  }

  /** Register one hand-written MCP tool (mcp-defs.ts) through the gate. */
  function registerDefinition(
    name: string,
    description: string,
    shape: z.ZodRawShape,
    run: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
  ) {
    registerGatedTool(server, callGate, ownerId, {
      kind: 'definition',
      name,
      description,
      shape,
      run,
    });
  }

  return {
    server,
    ownerId,
    /** The connection's login (absent on stdio, and for a peer that names
     *  none): whose thread a responder tool reads and writes (W7c fix
     *  round 1, M1). */
    loginId,
    transport,
    gate: callGate,
    stripVectors,
    jsonReply,
    registerBuiltinTools,
    registerDefinition,
    callBuiltin,
  };
}

/** What every register/*.ts module receives. */
export type McpRegisterContext = ReturnType<typeof makeRegisterContext>;
