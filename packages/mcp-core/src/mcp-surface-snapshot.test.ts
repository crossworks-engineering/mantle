/**
 * The A5 step 2 snapshot (workspaces arch plan v2, section 23.3): the owner
 * MCP surface as a client sees it, byte for byte, and every decision the
 * surface's own lists make, taken BEFORE the 16 hand-written MCP tools
 * became definitions and the lists became views of the policy tables.
 * The change must leave every file here as it is.
 *
 *  - tools/list over the real SDK (name, order, description, the advertised
 *    schema with the `workspace` argument): stdio and HTTP in full, and for
 *    every connection of the gate-policy matrix (gate-policy.test.ts, plus
 *    two connector rows) its names in order and a hash of its whole list.
 *  - for every registered name and a few names no table holds (a
 *    connector's, made-up ones of each family): what the surface's
 *    functions answer (read-only, risky, spending, key area, the key's
 *    shared-content and email lists, the Admin-only kind and tool lists)
 *    and the gate's reading of its MCP policy.
 *  - the surface's exported lists, sorted. Two are the policy's whole
 *    answer since step 2 (PEER_RISKY_TOOL_SLUGS, OWNER_KEY_SPENDING_TOOLS):
 *    each still holds what it held and says, for every registered tool,
 *    what the rule said.
 *
 * No database: registration and listing touch none.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import type { GatePolicy, ScopeArea, Tool, ToolHandler } from '@mantle/db';
import {
  BUILTIN_TOOLS,
  externalAccessToolSig,
  getBuiltin,
  type AdminGateView,
} from '@mantle/tools';
import { registerMantleTools } from './build-server';
import { mcpToolPolicy } from './gate-policy';
import { toolKeyArea } from './mcp-policy';
import {
  PEER_RISKY_TOOL_PREFIXES,
  callerAreasAllow,
  registerPreparedTools,
  type McpCaller,
  type PreparedCallerTools,
} from './login-surface';
import {
  ADMIN_KIND_CREATE_TOOL_SLUGS,
  ADMIN_ONLY_TOOL_SLUGS,
  isAdminOnlyTool,
  isMcpToolReadOnly,
  isPeerRiskyTool,
  KEY_SHARED_CONTENT_TOOLS,
  LIST_TOOLS,
  MCP_HANDWRITTEN_READ_ONLY,
  OWNER_KEY_SPENDING_TOOLS,
  PEER_RISKY_TOOL_SLUGS,
  spendsOwnerKeys,
  TOOLSMITH_WRITE_SLUGS,
} from './policy-views.test-helper';

const LOGIN = '00000000-0000-4000-8000-0000000000aa';
const BUILTIN = new Set(BUILTIN_TOOLS.map((d) => d.slug));
const AREAS: ScopeArea[] = ['settings', 'users', 'assistants', 'connectors', 'keys'];

/** Two connector rows: one with the admin's read-only mark, one without. */
function connectorRows(): { tool: Tool; readOnly: boolean }[] {
  const row = (toolName: string) =>
    ({
      slug: `mcp_crm_${toolName}`,
      description: `The crm ${toolName}.`,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      handler: { kind: 'mcp', group: 'mcp-crm', toolName } satisfies ToolHandler,
      requiresConfirm: false,
      externalAccess: null,
    }) as unknown as Tool;
  const base = row('contacts_update');
  const read = row('contacts_list');
  const marked = {
    ...read,
    externalAccess: {
      confirmedReadOnlyAt: new Date(0).toISOString(),
      by: { via: 'web' },
      handlerSig: externalAccessToolSig(read),
    },
  } as Tool;
  return [
    { tool: base, readOnly: false },
    { tool: marked, readOnly: true },
  ];
}

/** The gate-policy matrix (gate-policy.test.ts): each login kind,
 *  credential and scope, with the connectors prepareCallerTools keeps. */
function preparedMatrix(): PreparedCallerTools[] {
  // The unscoped connection (an Admin login on a brain not on workspaces)
  // went with the switch-over code in arch A7.
  const views: AdminGateView[] = [
    { holdsAdmin: false, areas: new Set<ScopeArea>() },
    { holdsAdmin: true, areas: new Set<ScopeArea>(AREAS) },
    { holdsAdmin: true, areas: new Set<ScopeArea>(['settings']) },
    { holdsAdmin: true, areas: new Set<ScopeArea>() },
  ];
  const callers: McpCaller[] = [];
  for (const role of ['admin', 'member'] as const) {
    for (const write of [true, false]) {
      callers.push({ role, anchorId: 'a', loginId: LOGIN, via: 'oauth', write });
      for (const areas of [null, ['pages', 'search'], ['app_data'], []]) {
        callers.push({ role, anchorId: 'a', loginId: LOGIN, via: 'key', write, areas, keyId: 'k' });
      }
      for (const riskyAllowed of [[], ['email_send', 'web_crawl', 'telegram_send']]) {
        callers.push({ role, anchorId: 'a', loginId: LOGIN, via: 'peer', write, riskyAllowed });
      }
    }
  }
  const out: PreparedCallerTools[] = [];
  for (const caller of callers) {
    // What prepareCallerTools keeps of the login's connector tools.
    const connectors = connectorRows()
      .filter((c) => (c.readOnly || caller.write) && callerAreasAllow(c.tool.slug, caller))
      .map((c) => c.tool);
    for (const view of views) {
      out.push({ kind: 'owner', caller, view, privateWs: null, connectors });
    }
  }
  return out;
}

const label = (p: PreparedCallerTools) =>
  p.kind === 'owner'
    ? `${p.caller.role}/${p.caller.via}/${p.caller.write ? 'rw' : 'ro'}/${JSON.stringify(p.caller.areas ?? null)}/${JSON.stringify(p.caller.riskyAllowed ?? [])}/${p.view.holdsAdmin}:${[...p.view.areas].join(',')}`
    : 'refused';

/** tools/list over the real SDK, for a server `register` fills. */
async function toolsList(register: (server: McpServer) => void) {
  const server = new McpServer({ name: 'mantle', version: '0.0.1' });
  register(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'mcp-surface-snapshot', version: '0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('tools/list, byte for byte (A5 step 2)', () => {
  it('stdio, in full', async () => {
    const tools = await toolsList((s) => registerMantleTools(s, 'owner-1', { transport: 'stdio' }));
    expect(tools.length).toBeGreaterThan(200);
    await expect(`${JSON.stringify(tools, null, 1)}\n`).toMatchFileSnapshot(
      './__snapshots__/tools-list.stdio.json',
    );
  });

  it('HTTP for the anchor, in full', async () => {
    const tools = await toolsList((s) => registerMantleTools(s, 'owner-1', { transport: 'http' }));
    await expect(`${JSON.stringify(tools, null, 1)}\n`).toMatchFileSnapshot(
      './__snapshots__/tools-list.http.json',
    );
  });

  it('every connection of the gate-policy matrix: names in order, and the hash of it all', async () => {
    const out: Record<string, { sha256: string; names: string[] }> = {};
    for (const p of preparedMatrix()) {
      const tools = await toolsList((s) => registerPreparedTools(s, p, { transport: 'http' }));
      out[label(p)] = { sha256: sha(JSON.stringify(tools)), names: tools.map((t) => t.name) };
    }
    expect(Object.keys(out)).toHaveLength(112);
    await expect(`${JSON.stringify(out, null, 1)}\n`).toMatchFileSnapshot(
      './__snapshots__/tools-list.matrix.json',
    );
  });
});

/** What the gate reads of a policy: its steps' fields and the narrowers'
 *  (`creates` by truth: the declared policy names the kind). */
function gateView(p: GatePolicy | null) {
  if (!p) return null;
  return {
    effect: p.effect,
    scope: p.scope,
    spends: p.spends,
    creates: Boolean(p.creates),
    keyArea: p.fields?.keyArea ?? null,
    peerRisky: p.fields?.peerRisky === true,
  };
}

/** Names no table holds: a connector's, and made-up ones of each family. */
const PROBES = [
  'mcp_crm_contacts_list',
  'web_made_up',
  'telegram_made_up',
  'sandbox_made_up',
  'peer_made_up',
  'app_made_up',
  'app_data_made_up',
  'page_made_up',
  'page_from_made_up',
  'my_app_made_up',
  'entity_made_up',
  'search_made_up',
  'made_up',
];

describe("the surface's decisions, per name (A5 step 2)", () => {
  it('for every registered name and every probe', async () => {
    const names: string[] = [];
    const capture = { registerTool: (name: string) => void names.push(name) };
    registerMantleTools(capture as never, 'owner-1', { transport: 'stdio' });
    const all = [...new Set([...names, ...PROBES])].sort();
    const out: Record<string, unknown> = {};
    for (const slug of all) {
      const known = BUILTIN.has(slug) || names.includes(slug);
      out[slug] = {
        readOnly: isMcpToolReadOnly(slug),
        peerRisky: isPeerRiskyTool(slug),
        spendsOwnerKeys: spendsOwnerKeys(slug),
        keyArea: toolKeyArea(slug),
        keySharedContent: KEY_SHARED_CONTENT_TOOLS.has(slug),
        keyEmailList: LIST_TOOLS.has(slug),
        adminKindCreate: ADMIN_KIND_CREATE_TOOL_SLUGS.has(slug),
        adminOnly: isAdminOnlyTool(slug, { ownerOnly: getBuiltin(slug)?.ownerOnly }),
        gate: known ? gateView(mcpToolPolicy({ kind: 'mcp-tool', name: slug })) : null,
      };
    }
    await expect(`${JSON.stringify(out, null, 1)}\n`).toMatchFileSnapshot(
      './__snapshots__/surface-decisions.json',
    );
  });
});

describe("the surface's exported lists (A5 step 2)", () => {
  /** The lists as they were (surface-lists.json, written before step 2). */
  const before = JSON.parse(
    readFileSync(new URL('./__snapshots__/surface-lists.json', import.meta.url), 'utf8'),
  ) as Record<string, string[]>;
  /** Each name's decisions as they were (surface-decisions.json). */
  const decisions = JSON.parse(
    readFileSync(new URL('./__snapshots__/surface-decisions.json', import.meta.url), 'utf8'),
  ) as Record<string, { peerRisky: boolean; spendsOwnerKeys: boolean; gate: unknown }>;

  it('each, sorted (the order of a list was never what it decides)', () => {
    const lists: Record<string, Iterable<string>> = {
      ADMIN_KIND_CREATE_TOOL_SLUGS,
      ADMIN_ONLY_TOOL_SLUGS,
      KEY_SHARED_CONTENT_TOOLS,
      LIST_TOOLS,
      MCP_HANDWRITTEN_READ_ONLY,
      OWNER_KEY_SPENDING_TOOLS,
      PEER_RISKY_TOOL_PREFIXES,
      PEER_RISKY_TOOL_SLUGS,
      TOOLSMITH_WRITE_SLUGS,
    };
    expect(Object.keys(lists).sort()).toEqual(Object.keys(before).sort());
    for (const [name, list] of Object.entries(lists)) {
      const now = [...list].sort();
      if (name === 'PEER_RISKY_TOOL_SLUGS' || name === 'OWNER_KEY_SPENDING_TOOLS') {
        // Step 2 made these two the policy's whole answer (every tool whose
        // policy says peerRisky, or spends ownerKey), where each list named
        // some tools and rules named the rest: each holds what it held, and
        // for every tool the surface registers it says what the rule said.
        const field = name === 'PEER_RISKY_TOOL_SLUGS' ? 'peerRisky' : 'spendsOwnerKeys';
        for (const slug of before[name]!) expect(now, `${name} ${slug}`).toContain(slug);
        const tools = Object.keys(decisions).filter((n) => decisions[n]!.gate !== null);
        expect(
          now.filter((n) => tools.includes(n)),
          name,
        ).toEqual(tools.filter((n) => decisions[n]![field]));
      } else {
        expect(now, name).toEqual(before[name]);
      }
    }
  });
});
