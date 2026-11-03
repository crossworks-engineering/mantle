/**
 * A status-only linked brain (McpCaller.statusOnly, docs/federation.md
 * "Status links") reaches box_status and brain_capacity and nothing else,
 * on every shape of the surface:
 *
 *  - registration: only the two are registered, on the full list or when
 *    the tool map is asked for (no tool_read, tool_write, tool_send,
 *    tool_delete or tool_help: there is no map to reach anything through);
 *  - the gate: what the connection lists (preparedLists, the gate's own
 *    listing) is the two, and the peer narrower refuses any other name at
 *    call time, a builtin, a hand-written MCP tool, a call tool or a
 *    connector row alike;
 *  - instructions: it is told what it may call, and nothing about the rest.
 *
 * The caller is built as server/web/lib/mcp-auth.ts builds one: the owner,
 * read-only, no risky tools. No database: the prepared connection is made by
 * hand, as the listing reads it.
 */
import { describe, expect, it } from 'vitest';
import type { GateCaller, GatePolicy, PolicyRef, ScopeArea } from '@mantle/db';
import { GATE_NARROWERS, STATUS_ONLY_ERROR, listBuiltins, mcpBuiltinToolRef } from '@mantle/tools';
import {
  MCP_STATUS_ONLY_INSTRUCTIONS,
  mcpInstructionsFor,
  preparedLists,
  registerPreparedTools,
  type McpCaller,
  type PreparedCallerTools,
} from './login-surface';
import { mcpGateCaller } from './gate-policy';
import { MCP_TOOL_DEFS } from './mcp-defs';

const OWNER = '00000000-0000-4000-8000-000000000001';
const AREAS: ScopeArea[] = ['settings', 'connectors', 'users', 'keys', 'assistants'] as ScopeArea[];

function statusCaller(): McpCaller {
  return {
    role: 'admin',
    anchorId: OWNER,
    loginId: OWNER,
    displayName: 'owner',
    via: 'peer',
    peerId: 'peer-1',
    peerByOwner: false,
    write: false,
    riskyAllowed: [],
    statusOnly: true,
  };
}

/** The owner's scope: Admin, every area, so nothing but the status rule
 *  narrows. */
function prepared(caller: McpCaller): PreparedCallerTools {
  return {
    kind: 'owner',
    caller,
    view: { holdsAdmin: true, areas: new Set(AREAS) },
    privateWs: null,
    connectors: [],
  };
}

/** Register onto a capturing fake: the names the server would list. */
function registered(p: PreparedCallerTools, toolMap: boolean): string[] {
  const names: string[] = [];
  registerPreparedTools({ registerTool: (n: string) => void names.push(n) } as never, p, {
    transport: 'http',
    toolMap,
  });
  return names.sort();
}

const STATUS = ['box_status', 'brain_capacity'];

describe('a status-only linked brain', () => {
  it('registers the status tools only, on the full list', () => {
    expect(registered(prepared(statusCaller()), false)).toEqual(STATUS);
  });

  it('registers the status tools only when the tool map is asked for: no call tool, no tool_help', () => {
    const names = registered(prepared(statusCaller()), true);
    expect(names).toEqual(STATUS);
    for (const meta of ['tool_help', 'tool_read', 'tool_write', 'tool_send', 'tool_delete']) {
      expect(names).not.toContain(meta);
    }
  });

  it('the gate lists the status tools and nothing else of every builtin and MCP tool', () => {
    const p = prepared(statusCaller());
    const names = new Set([
      ...listBuiltins().map((d) => d.slug),
      ...MCP_TOOL_DEFS.map((d) => d.slug),
      'search',
      'tool_read',
      'tool_help',
    ]);
    const listed = [...names].filter((n) => preparedLists(p, n)).sort();
    expect(listed).toEqual(STATUS);
  });

  it('the peer narrower refuses any other name at call time, whatever the ref kind', () => {
    const caller = mcpGateCaller(prepared(statusCaller())) as GateCaller;
    const readPolicy: GatePolicy = Object.freeze({
      effect: 'read',
      scope: 'any',
      spends: 'none',
      fields: Object.freeze({ peerRisky: false }),
    });
    const refs: PolicyRef[] = [
      mcpBuiltinToolRef('page_list', 'page_list'),
      Object.freeze({ kind: 'mcp-tool', name: 'search' }),
      Object.freeze({ kind: 'mcp-tool', name: 'tool_read' }),
      Object.freeze({ kind: 'mcp-tool', name: 'tool_help' }),
      Object.freeze({ kind: 'tool', name: 'note_get' }),
      Object.freeze({ kind: 'runtime-tool', name: 'mcp_crm_list', row: {} }),
    ];
    for (const ref of refs) {
      expect(GATE_NARROWERS.peer(caller, readPolicy, ref), ref.name).toBe(STATUS_ONLY_ERROR);
    }
    for (const name of STATUS) {
      expect(
        GATE_NARROWERS.peer(caller, readPolicy, mcpBuiltinToolRef(name, name)),
        name,
      ).toBeNull();
    }
  });

  it('is told what it may call, and nothing about the rest', () => {
    const p = prepared(statusCaller());
    expect(mcpInstructionsFor(p.caller, p)).toBe(MCP_STATUS_ONLY_INSTRUCTIONS);
    expect(mcpInstructionsFor(p.caller, p, { toolMap: true })).toBe(MCP_STATUS_ONLY_INSTRUCTIONS);
  });

  it('the same peer without the status scope (a full peer bound to the owner) is not narrowed so', () => {
    const { statusOnly: _drop, ...rest } = statusCaller();
    const p = prepared({ ...rest, write: true });
    expect(registered(p, false).length).toBeGreaterThan(100);
    expect(preparedLists(p, 'page_list')).toBe(true);
  });
});
