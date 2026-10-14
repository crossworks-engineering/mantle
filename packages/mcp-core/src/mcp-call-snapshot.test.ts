/**
 * The A5 step 4 snapshot (workspaces arch plan v2, section 23.3): what an
 * MCP client gets back from the owner surface, byte for byte, for every
 * kind of connection, taken BEFORE MCP registration moved onto the one
 * gate. Over the real SDK (an in-memory client and server), so the SDK's
 * own answers (an unknown tool, a thrown error) are in it too:
 *
 *  - per connection: the server instructions and tools/list (a hash of the
 *    whole list and its length; tools-list.matrix.json holds the names);
 *  - per call: the reply (each content block, isError, the "Error: "
 *    prefix), or the protocol error; what the tool's handler saw (its
 *    input, its surface, the create home it ran under); the landing
 *    workspace a create names (landedIn); the image blocks of a picture;
 *    and the rows written to the audit log (mcp.connector.*).
 *
 * The connections are the gate-policy matrix's kinds as prepareCallerTools
 * makes them (an Admin user, a member with a private workspace, a member
 * with none, a key without Search, a peer, a login in no workspace, an
 * Admin user on a brain not on workspaces and on the rollback switch) and
 * stdio. No database: every read the surface makes is answered here, by
 * module path, so the same answers reach the code before and after the
 * change. The handlers of the builtins called are replaced on their
 * definitions (the one object the surface and the registry share).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  onWorkspaces: true,
  /** loginId -> its workspaces (ws, modWs). */
  scopes: new Map<string, { ws: string[]; modWs: string[] }>(),
  /** loginId -> holds the Admin workspace. */
  admin: new Map<string, boolean>(),
  /** loginId -> its Admin areas. */
  areas: new Map<string, string[]>(),
  /** loginId -> its private workspace (the create home's fallback). */
  privateWs: new Map<string, string | null>(),
  /** What landedIn reads for the items a create made. */
  landing: [] as { id: string; name: string }[],
  /** Rows written (the audit log). */
  inserts: [] as { table: string; values: unknown }[],
  /** What each handler saw. */
  seen: [] as Record<string, unknown>[],
  /** loginId -> its connector tool rows. */
  connectors: new Map<string, { tool: unknown; readOnly: boolean }[]>(),
  connectorRefusal: null as string | null,
  remote: [] as Record<string, unknown>[],
}));

const ids = vi.hoisted(() => ({
  OWNER: '00000000-0000-4000-8000-000000000001',
  ADMIN: '00000000-0000-4000-8000-0000000000a1',
  MEMBER: '00000000-0000-4000-8000-0000000000b1',
  NOHOME: '00000000-0000-4000-8000-0000000000c1',
  LONE: '00000000-0000-4000-8000-0000000000d1',
  ADMIN_WS: '10000000-0000-4000-8000-000000000001',
  TEAM_WS: '10000000-0000-4000-8000-000000000002',
  PRIVATE_WS: '10000000-0000-4000-8000-000000000003',
  NOTE: '20000000-0000-4000-8000-000000000001',
  NEW_NOTE: '20000000-0000-4000-8000-000000000002',
  MAIL: '20000000-0000-4000-8000-000000000003',
  PAGE: '20000000-0000-4000-8000-000000000004',
  SHARED: '20000000-0000-4000-8000-000000000005',
  REFUSED: '20000000-0000-4000-8000-000000000006',
  PRE_FAIL: '20000000-0000-4000-8000-000000000007',
  DRAW: '20000000-0000-4000-8000-000000000008',
  FILE: '20000000-0000-4000-8000-000000000009',
}));

// ── The database's answers, by module path ─────────────────────────────────

vi.mock('../../db/src/client', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const viewer = await import('@mantle/db/viewer');
  const schema = await import('@mantle/db/schema');
  const nameOf = (t: unknown) =>
    t === schema.nodes
      ? 'nodes'
      : t === schema.toolGroups
        ? 'tool_groups'
        : t === schema.auditLog
          ? 'audit_log'
          : 'other';
  const rowsFor = (table: string): unknown[] => {
    if (table === 'nodes') return st.landing;
    if (table === 'tool_groups') {
      return [
        {
          id: 'g1',
          slug: 'mcp-crm',
          enabled: true,
          configuredBy: null,
          integration: { mcp: { url: 'https://crm.example.invalid/mcp' } },
        },
      ];
    }
    return [];
  };
  const chain = () => {
    let table = 'other';
    const q: Record<string, unknown> = {};
    for (const m of ['innerJoin', 'leftJoin', 'where', 'limit', 'orderBy', 'groupBy'])
      q[m] = () => q;
    q.from = (t: unknown) => {
      table = nameOf(t);
      return q;
    };
    q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
      Promise.resolve(rowsFor(table)).then(ok, bad);
    return q;
  };
  const fakeDb = {
    select: () => chain(),
    insert: (t: unknown) => ({
      values: (values: unknown) => {
        st.inserts.push({ table: nameOf(t), values });
        return Promise.resolve([]);
      },
    }),
  };
  const scopeLogin = () => viewer.currentWorkspaceScope()?.loginId ?? null;
  return {
    ...real,
    db: fakeDb,
    brainOnWorkspacesNow: async () => st.onWorkspaces,
    loginScopeFor: async (loginId: string) => {
      const s = st.scopes.get(loginId) ?? { ws: [], modWs: [] };
      return { kind: 'user', loginId, ws: [...s.ws], modWs: [...s.modWs] };
    },
    scopeHoldsAdmin: async () => {
      const login = scopeLogin();
      return login === null ? true : st.admin.get(login) === true;
    },
    scopeHasArea: async (area: string) => {
      const login = scopeLogin();
      if (login === null) return true;
      return st.admin.get(login) === true && (st.areas.get(login) ?? []).includes(area);
    },
    loginHasArea: async (loginId: string, area: string) =>
      (st.areas.get(loginId) ?? []).includes(area),
  };
});

vi.mock('../../db/src/create-home', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    createHomeIntent: async (
      loginId: string,
      ask: { from: string; workspace?: unknown } | null,
      fallback: { privateWs: string | null } | { ownWork: unknown; makePrivate: boolean },
    ) => {
      let createWs: string | null = null;
      if (ask && ask.from === 'argument') {
        if (ask.workspace === 'nope') {
          return {
            refused: 'unknown',
            message:
              'You are not in a workspace "nope". List yours with workspaces_list and pass one you moderate.',
          };
        }
        if (ask.workspace === 'Team') createWs = ids.TEAM_WS;
      }
      const privateWs =
        'privateWs' in fallback ? fallback.privateWs : (st.privateWs.get(loginId) ?? null);
      return { createWs, privateWs };
    },
  };
});

vi.mock('../../db/src/viewer', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  // As the system: the work itself, here (the database is answered above).
  return { ...real, asSystem: (fn: () => Promise<unknown>) => fn() };
});

// ── The tools' own reads ────────────────────────────────────────────────────

vi.mock('../../tools/src/preconditions', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    checkToolPreconditions: async (_pre: unknown, input: Record<string, unknown>) =>
      Object.values(input).includes(ids.PRE_FAIL)
        ? { ok: false, error: `${ids.PRE_FAIL} is not a page this brain holds.` }
        : null,
  };
});

vi.mock('../../tools/src/item-write-gate', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    toolItemWriteRefusal: async (_slug: string, input: Record<string, unknown>) =>
      Object.values(input).includes(ids.REFUSED)
        ? 'You cannot change this item in your workspaces.'
        : null,
    // The same refusal with its edit check detail (A5 step 4 fix round 2:
    // the item pre-check asks this one; only a /api/v1 route reads the
    // detail, so every MCP answer here is the words above).
    toolItemWriteRefusalOf: async (_slug: string, input: Record<string, unknown>) =>
      Object.values(input).includes(ids.REFUSED)
        ? { message: 'You cannot change this item in your workspaces.', detail: 'no_edit' }
        : null,
  };
});

vi.mock('../../tools/src/shared-item', () => ({
  othersCanRead: async (_owner: string, id: string) => id === ids.SHARED,
}));

vi.mock('../../tools/src/external-access', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    listLoginConnectorTools: async (_owner: string, loginId: string) =>
      st.connectors.get(loginId) ?? [],
    loginConnectorRefused: async () => st.connectorRefusal,
    connectorResources: async (_o: string, _g: string, ws: readonly string[]) =>
      ws.map((workspaceId) => ({ workspaceId, write: true })),
  };
});

vi.mock('../../tools/src/mcp-client', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    mcpCallRemoteTool: async (
      _o: string,
      group: string,
      _mcp: unknown,
      toolName: string,
      input: Record<string, unknown>,
    ) => {
      const { currentCreateHome } = await import('@mantle/db/viewer');
      st.remote.push({ group, toolName, input, home: currentCreateHome() });
      return { text: JSON.stringify({ found: 1, toolName }), isError: false, secrets: [] };
    },
  };
});

vi.mock('../../files/src/email-attachments', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    reachesEmailAttachment: async (_o: string, ref: { id?: string }) => ref.id === ids.MAIL,
    emailAttachmentIds: async (_o: string, list: readonly string[]) =>
      new Set(list.filter((id) => id === ids.MAIL)),
    emailAttachmentFolders: async () => new Set<string>(),
  };
});

import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import {
  currentCreateHome,
  loginActor,
  runAsActor,
  type Actor,
  type Tool,
  type ToolHandler,
} from '@mantle/db';
import { errorMessage } from '@mantle/std';
import {
  externalAccessToolSig,
  getBuiltin,
  type BuiltinToolDef,
  type ToolHandlerContext,
} from '@mantle/tools';
import { MANTLE_MCP_INSTRUCTIONS, registerMantleTools } from './build-server';
import {
  mcpInstructionsFor,
  prepareCallerTools,
  registerPreparedTools,
  type McpCaller,
} from './login-surface';

// ── The builtins called, their handlers replaced ────────────────────────────

/** A Postgres error, as drizzle wraps it. */
function pgError(): Error {
  return Object.assign(new Error('Failed query: select secret_words from nodes\nparams: x'), {
    name: 'DrizzleQueryError',
    cause: Object.assign(new Error('duplicate key value violates "nodes_secret_key"'), {
      code: '23505',
      severity: 'ERROR',
    }),
  });
}

const FAKED = [
  'note_list',
  'note_get',
  'note_create',
  'page_split',
  'page_update',
  'draw_get',
  'search_nodes',
  'replay_window',
] as const;

function fakeHandler(slug: string): BuiltinToolDef['handler'] {
  return async (input: Record<string, unknown>, ctx: ToolHandlerContext) => {
    st.seen.push({ slug, input, surface: ctx.surface ?? null, home: currentCreateHome() });
    const id = input.id ?? input.page_id;
    if (id === 'plain-error') return { ok: false, error: 'plain refusal words' };
    if (id === 'db-text') return { ok: false, error: `could not read: ${errorMessage(pgError())}` };
    if (id === 'db-throw') throw pgError();
    if (id === 'plain-throw') throw new Error('boom, not a database error');
    switch (slug) {
      case 'note_list':
        return {
          ok: true,
          output: [
            { id: ids.NOTE, title: 'A note', embedding: [0.1, 0.2] },
            { id: ids.MAIL, title: 'From a mail' },
          ],
        };
      case 'note_create':
        return { ok: true, output: { id: ids.NEW_NOTE, title: input.title } };
      case 'page_split':
        return { ok: true, output: { page_id: ids.PAGE, pages: [{ id: ids.NEW_NOTE }] } };
      case 'draw_get':
        return {
          ok: true,
          output: { id: ids.DRAW, title: 'A drawing' },
          modelImages: [{ base64: 'aW1hZ2U=', mimeType: 'image/png' }],
        };
      case 'search_nodes':
        return { ok: true, output: [{ id: ids.NOTE, url: `/n/${ids.NOTE}` }] };
      default:
        return { ok: true, output: { slug, ran: true } };
    }
  };
}

const realHandlers = new Map<string, BuiltinToolDef['handler']>();
beforeAll(() => {
  for (const slug of FAKED) {
    const def = getBuiltin(slug)!;
    realHandlers.set(slug, def.handler);
    (def as { handler: BuiltinToolDef['handler'] }).handler = fakeHandler(slug);
  }
});
afterAll(() => {
  for (const [slug, handler] of realHandlers) {
    (getBuiltin(slug) as { handler: BuiltinToolDef['handler'] }).handler = handler;
  }
});

// ── The connections ─────────────────────────────────────────────────────────

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
  const update = row('contacts_update');
  const list = row('contacts_list');
  const marked = {
    ...list,
    externalAccess: {
      confirmedReadOnlyAt: new Date(0).toISOString(),
      by: { via: 'web' },
      handlerSig: externalAccessToolSig(list),
    },
  } as Tool;
  return [
    { tool: update, readOnly: false },
    { tool: marked, readOnly: true },
  ];
}

function seedLogins(): void {
  st.scopes.set(ids.ADMIN, { ws: [ids.ADMIN_WS, ids.TEAM_WS], modWs: [ids.ADMIN_WS] });
  st.admin.set(ids.ADMIN, true);
  st.areas.set(ids.ADMIN, ['settings', 'users', 'assistants', 'connectors', 'keys']);
  st.privateWs.set(ids.ADMIN, null);
  st.scopes.set(ids.OWNER, { ws: [ids.ADMIN_WS], modWs: [ids.ADMIN_WS] });
  st.admin.set(ids.OWNER, true);
  st.areas.set(ids.OWNER, ['settings', 'users', 'assistants', 'connectors', 'keys']);
  st.scopes.set(ids.MEMBER, { ws: [ids.TEAM_WS, ids.PRIVATE_WS], modWs: [ids.PRIVATE_WS] });
  st.admin.set(ids.MEMBER, false);
  st.privateWs.set(ids.MEMBER, ids.PRIVATE_WS);
  st.scopes.set(ids.NOHOME, { ws: [ids.TEAM_WS], modWs: [] });
  st.admin.set(ids.NOHOME, false);
  st.privateWs.set(ids.NOHOME, null);
  st.scopes.set(ids.LONE, { ws: [], modWs: [] });
  st.admin.set(ids.LONE, false);
  for (const login of [ids.ADMIN, ids.MEMBER, ids.NOHOME, ids.LONE]) {
    st.connectors.set(login, connectorRows());
  }
}

type Conn = {
  label: string;
  caller: McpCaller | 'stdio';
  onWorkspaces?: boolean;
  rollback?: boolean;
};

const CONNECTIONS: Conn[] = [
  { label: 'stdio owner', caller: 'stdio' },
  {
    label: 'admin oauth rw',
    caller: { role: 'admin', anchorId: ids.OWNER, loginId: ids.ADMIN, via: 'oauth', write: true },
  },
  {
    label: 'admin oauth rw, rollback switch',
    caller: { role: 'admin', anchorId: ids.OWNER, loginId: ids.ADMIN, via: 'oauth', write: true },
    rollback: true,
  },
  {
    label: 'admin oauth rw, brain not on workspaces',
    caller: { role: 'admin', anchorId: ids.OWNER, loginId: ids.ADMIN, via: 'oauth', write: true },
    onWorkspaces: false,
  },
  {
    label: 'member oauth rw (private workspace)',
    caller: { role: 'member', anchorId: ids.OWNER, loginId: ids.MEMBER, via: 'oauth', write: true },
  },
  {
    label: 'member oauth ro',
    caller: {
      role: 'member',
      anchorId: ids.OWNER,
      loginId: ids.MEMBER,
      via: 'oauth',
      write: false,
    },
  },
  {
    label: 'member oauth rw (no private workspace)',
    caller: { role: 'member', anchorId: ids.OWNER, loginId: ids.NOHOME, via: 'oauth', write: true },
  },
  {
    label: 'member key rw, notes pages files (no search)',
    caller: {
      role: 'member',
      anchorId: ids.OWNER,
      loginId: ids.MEMBER,
      via: 'key',
      write: true,
      keyId: 'key-1',
      areas: ['notes', 'pages', 'files'],
    },
  },
  {
    label: 'member key ro, every area',
    caller: {
      role: 'member',
      anchorId: ids.OWNER,
      loginId: ids.MEMBER,
      via: 'key',
      write: false,
      keyId: 'key-2',
      areas: null,
    },
  },
  {
    label: 'admin peer rw (not the owner’s), nothing risky named',
    caller: {
      role: 'admin',
      anchorId: ids.OWNER,
      loginId: ids.ADMIN,
      via: 'peer',
      write: true,
      riskyAllowed: [],
      peerId: 'peer-1',
    },
  },
  {
    label: 'member peer rw',
    caller: {
      role: 'member',
      anchorId: ids.OWNER,
      loginId: ids.MEMBER,
      via: 'peer',
      write: true,
      riskyAllowed: [],
      peerId: 'peer-2',
    },
  },
  {
    label: 'member in no workspace',
    caller: { role: 'member', anchorId: ids.OWNER, loginId: ids.LONE, via: 'oauth', write: true },
  },
];

/** The calls every connection makes, in order. */
const CALLS: { name: string; args: Record<string, unknown>; refuse?: string }[] = [
  { name: 'note_list', args: {} },
  { name: 'note_get', args: { id: ids.NOTE } },
  { name: 'note_get', args: { id: 'plain-error' } },
  { name: 'note_get', args: { id: 'db-text' } },
  { name: 'note_get', args: { id: 'db-throw' } },
  { name: 'note_get', args: { id: 'plain-throw' } },
  { name: 'note_get', args: { id: ids.MAIL } },
  { name: 'note_create', args: { title: 'New', content: 'body' } },
  { name: 'note_create', args: { title: 'New', content: 'body', workspace: 'Team' } },
  { name: 'note_create', args: { title: 'New', content: 'body', workspace: 'nope' } },
  // A create that names an item: the create home's refusal and the item
  // pre-check's (page_split, page_extract_section, app_duplicate).
  { name: 'page_split', args: { page_id: ids.REFUSED, by: 'h1', workspace: 'nope' } },
  { name: 'page_split', args: { page_id: ids.REFUSED, by: 'h1' } },
  { name: 'page_split', args: { page_id: ids.PRE_FAIL, by: 'h1', workspace: 'nope' } },
  { name: 'page_split', args: { page_id: ids.PAGE, by: 'h2' } },
  { name: 'page_split', args: { page_id: ids.SHARED, by: 'h2', workspace: 'nope' } },
  {
    name: 'page_extract_section',
    args: { page_id: ids.REFUSED, heading_block_id: 'b1', workspace: 'nope' },
  },
  { name: 'page_extract_section', args: { page_id: ids.REFUSED, heading_block_id: 'b1' } },
  { name: 'app_duplicate', args: { id: ids.REFUSED, workspace: 'nope' } },
  { name: 'app_duplicate', args: { id: ids.REFUSED } },
  { name: 'page_update', args: { id: ids.SHARED, markdown: 'x', confirm: true } },
  { name: 'page_update', args: { id: ids.PAGE, markdown: 'x', confirm: true } },
  { name: 'page_update', args: { id: ids.PRE_FAIL, markdown: 'x' } },
  { name: 'page_update', args: { id: ids.REFUSED, markdown: 'x' } },
  { name: 'draw_get', args: { id: ids.DRAW, image: true } },
  { name: 'search', args: { q: 'invoice' } },
  { name: 'file_rename', args: { file_id: ids.REFUSED, new_stem: 'x' } },
  { name: 'replay_window', args: { from: '2026-10-01', to: '2026-10-02' } },
  { name: 'mcp_crm_contacts_list', args: { q: 'acme' } },
  { name: 'mcp_crm_contacts_update', args: { q: 'acme', confirm: true } },
  {
    name: 'mcp_crm_contacts_update',
    args: { q: 'acme' },
    refuse: 'This connector is not one of your workspaces’ resources.',
  },
  { name: 'no_such_tool', args: {} },
];

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** The stdio entry's binding (server/mcp/src/stdio-actor.ts connectStdioAs):
 *  the connect and every message the transport delivers run as `actor`. */
async function connectAs(
  actor: Actor,
  server: McpServer,
  transport: { onmessage?: (...args: never[]) => void },
): Promise<void> {
  await runAsActor(actor, () => server.connect(transport as never));
  const onMessage = transport.onmessage;
  if (!onMessage) return;
  transport.onmessage = (...args: never[]) => runAsActor(actor, () => onMessage(...args));
}

async function session(conn: Conn) {
  st.onWorkspaces = conn.onWorkspaces !== false;
  if (conn.rollback) process.env.MANTLE_ADMIN_READS = 'system';
  else delete process.env.MANTLE_ADMIN_READS;
  let instructions: string;
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  if (conn.caller === 'stdio') {
    instructions = MANTLE_MCP_INSTRUCTIONS;
    const server = new McpServer({ name: 'mantle', version: '0.0.1' }, { instructions });
    registerMantleTools(server, ids.OWNER, { transport: 'stdio' });
    await connectAs(loginActor(ids.OWNER, 'owner'), server, serverSide);
  } else {
    const prepared = await prepareCallerTools(conn.caller);
    instructions = mcpInstructionsFor(conn.caller, prepared);
    // As the HTTP route builds it (server/web lib/mcp-http.ts): it answers
    // tools/list and tools/call whatever it registers.
    const server = new McpServer(
      { name: 'mantle', version: '0.0.1' },
      { instructions, capabilities: { tools: { listChanged: false } } },
    );
    registerPreparedTools(server, prepared, { transport: 'http' });
    await server.connect(serverSide);
  }
  const client = new Client({ name: 'mcp-call-snapshot', version: '0' });
  await client.connect(clientSide);
  return { client, instructions };
}

describe('MCP calls, byte for byte (A5 step 4)', () => {
  it('every connection: instructions, tools/list, and each call', async () => {
    seedLogins();
    const out: Record<string, unknown> = {};
    try {
      for (const conn of CONNECTIONS) {
        const { client, instructions } = await session(conn);
        const { tools } = await client.listTools();
        const calls: unknown[] = [];
        for (const call of CALLS) {
          st.seen = [];
          st.inserts = [];
          st.remote = [];
          st.landing = [{ id: ids.PRIVATE_WS, name: 'Private' }];
          st.connectorRefusal = call.refuse ?? null;
          let reply: unknown;
          try {
            reply = await client.callTool({ name: call.name, arguments: call.args });
          } catch (err) {
            reply = { protocolError: err instanceof Error ? err.message : String(err) };
          }
          calls.push({
            call: `${call.name} ${JSON.stringify(call.args)}${call.refuse ? ' (connector refused)' : ''}`,
            reply,
            handler: st.seen,
            remote: st.remote,
            inserts: st.inserts,
          });
        }
        await client.close();
        out[conn.label] = {
          instructions,
          tools: { count: tools.length, sha256: sha(JSON.stringify(tools)) },
          calls,
        };
      }
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
      st.onWorkspaces = true;
    }
    expect(Object.keys(out)).toHaveLength(CONNECTIONS.length);
    await expect(`${JSON.stringify(out, null, 1)}\n`).toMatchFileSnapshot(
      './__snapshots__/mcp-calls.json',
    );
  }, 120_000);
});
