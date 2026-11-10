/**
 * The one rule (owner, 2026-11-07): an agent may tighten a gate, never loosen
 * one. The list is packages/tools person-only-acts.ts.
 *
 * Over the real SDK, as a client sees it. A whole-tool row is on no surface. A
 * param row is refused before its tool runs, for every agent, and the same
 * tool still takes the value that tightens. The sweep then reads every tool's
 * input schema: a param or a name that looks like a gate, or that changes what a
 * tool group holds, is on the list or on the stated exempt list here, so a new
 * one cannot slip past.
 *
 * No database: an unknown tool and a refused param are answered before any
 * call runs.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import type { ScopeArea } from '@mantle/db';
import {
  BUILTIN_TOOLS,
  PERSON_ONLY_ACTS,
  appBrokerCaller,
  dispatchTool,
  isPersonOnlyTool,
  ownerWebCaller,
  pendingCaller,
  personOnlyRefusal,
  reservedSlugError,
  runCaller,
  turnCaller,
} from '@mantle/tools';
import { registerMantleTools } from './build-server';
import { registerPreparedTools, type McpCaller } from './login-surface';

const LOGIN = '00000000-0000-4000-8000-0000000000aa';
const ROW = '11111111-2222-4333-8444-555555555555';
const AREAS: ScopeArea[] = ['settings', 'users', 'assistants', 'connectors', 'keys'];

/** An Admin login with every area on, as prepareCallerTools gives it. */
const adminOn = (caller: Partial<McpCaller>) => (s: McpServer) =>
  registerPreparedTools(
    s,
    {
      kind: 'owner',
      caller: {
        role: 'admin',
        anchorId: 'owner-1',
        loginId: LOGIN,
        write: true,
        ...caller,
      } as McpCaller,
      view: { holdsAdmin: true, areas: new Set(AREAS) },
      privateWs: null,
      connectors: [],
    },
    { transport: 'http' },
  );

const SURFACES: [string, (s: McpServer) => void][] = [
  ['stdio, the anchor', (s) => registerMantleTools(s, 'owner-1', { transport: 'stdio' })],
  ['HTTP, the anchor', (s) => registerMantleTools(s, 'owner-1', { transport: 'http' })],
  ['HTTP, an Admin login on OAuth', adminOn({ via: 'oauth' })],
];

/** A key and a peer of an Admin login: narrowed further, and never a way in,
 *  whatever the peer is allowed. */
const NARROWED: [string, (s: McpServer) => void][] = [
  ['an API key', adminOn({ via: 'key', areas: null, keyId: 'k' })],
  [
    'a peer naming them all',
    adminOn({
      via: 'peer',
      riskyAllowed: [...new Set(PERSON_ONLY_ACTS.map((a) => a.tool)), 'api_tool_update'],
    }),
  ],
];

/** A client on a server `register` fills. */
async function clientOf(register: (s: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: 'mantle', version: '0.0.1' });
  register(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'person-only-acts', version: '0' });
  await client.connect(clientSide);
  return client;
}

/** What a call to `name` answers: the SDK throws for a tool it does not hold
 *  or answers with an error, and a tool it holds answers something else. */
async function answerTo(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const r = (await client.callTool({ name, arguments: args })) as {
      content?: { text?: string }[];
    };
    return (r.content ?? []).map((p) => p.text ?? '').join(' ');
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const WHOLE = PERSON_ONLY_ACTS.filter((a) => a.param === undefined).map((a) => a.tool);
const PARAM_ROWS = PERSON_ONLY_ACTS.filter((a) => a.param !== undefined);

describe('the list', () => {
  it('holds the acts the owner named, each with a reason and a place', () => {
    expect(WHOLE.sort()).toEqual([
      'pending_approve',
      'recall_map_publish',
      'recall_prompt_confirm',
      'recall_revision_restore',
    ]);
    // Each names the one value an agent may send.
    expect(PARAM_ROWS.map((a) => `${a.tool}.${a.param}=${String(a.agentValue)}`).sort()).toEqual([
      'api_tool_update.enabled=false',
      'api_tool_update.external_access=false',
      'api_tool_update.requires_confirm=true',
      'control_ban.archive=false',
    ]);
    for (const a of PERSON_ONLY_ACTS) {
      expect(a.why.length, a.tool).toBeGreaterThan(10);
      expect(a.where.length, a.tool).toBeGreaterThan(5);
    }
  });

  it.each(WHOLE)('%s is no builtin, and no authored tool may take its name', (slug) => {
    expect(BUILTIN_TOOLS.map((t) => t.slug)).not.toContain(slug);
    expect(isPersonOnlyTool(slug)).toBe(true);
    expect(reservedSlugError(slug)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is reserved/),
    });
  });
});

describe.each(SURFACES)('over MCP: %s', (_name, register) => {
  it('lists no whole-tool row, and answers a call to one not found', async () => {
    const client = await clientOf(register);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const slug of WHOLE) {
        expect(names, slug).not.toContain(slug);
        expect(await answerTo(client, slug, { id: ROW })).toMatch(
          new RegExp(`Tool ${slug} not found`),
        );
      }
    } finally {
      await client.close();
    }
  });

  it("the queue's reads and rejection stay, and telegram_pair lists no way to confirm", async () => {
    const client = await clientOf(register);
    try {
      const tools = (await client.listTools()).tools;
      const names = tools.map((t) => t.name);
      for (const slug of ['pending_list', 'pending_get', 'pending_reject']) {
        expect(names, slug).toContain(slug);
        // A bad status or a missing id: refused by the tool's own schema
        // before it reads anything, which proves the tool answered.
        const args = slug === 'pending_list' ? { status: 'no-such-queue' } : {};
        const answer = await answerTo(client, slug, args);
        expect(answer).not.toMatch(/Tool \S+ not found/);
        expect(answer).toMatch(slug === 'pending_list' ? /status/ : /\bid\b/);
      }
      const pair = tools.find((t) => t.name === 'telegram_pair');
      expect(Object.keys(pair!.inputSchema.properties ?? {})).toEqual(['code']);
      expect(pair!.description).toMatch(/a person confirms the pairing in the app/);
    } finally {
      await client.close();
    }
  });
});

// The anchor's connection reads the database before it calls (the Admin view),
// so its own cell is in server/web/server/person-acts-routes.db.test.ts.
describe('over MCP, a param row: HTTP, an Admin login on OAuth', () => {
  const register = adminOn({ via: 'oauth' });
  it.each([
    ['requires_confirm', { requires_confirm: false }],
    ['enabled', { enabled: true }],
    ['external_access', { external_access: true, read_only_confirmed: true }],
  ])('refuses api_tool_update %s that loosens, and names the screen', async (_param, args) => {
    const client = await clientOf(register);
    try {
      const answer = await answerTo(client, 'api_tool_update', { slug: 'some_tool', ...args });
      expect(answer).toMatch(/a person's act, not an agent's/);
      expect(answer).toMatch(/Settings > Tools/);
    } finally {
      await client.close();
    }
  });
});

describe.each(NARROWED)('over MCP: an Admin login by %s', (_name, register) => {
  it('lists no whole-tool row and reaches no param row', async () => {
    const client = await clientOf(register);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const slug of WHOLE) {
        expect(names, slug).not.toContain(slug);
        expect(await answerTo(client, slug, { id: ROW })).toMatch(
          new RegExp(`Tool ${slug} not found`),
        );
      }
      expect(
        await answerTo(client, 'api_tool_update', { slug: 'some_tool', requires_confirm: false }),
      ).toMatch(/Tool api_tool_update not found|a person's act/);
    } finally {
      await client.close();
    }
  });
});

describe('the one check', () => {
  const row = { slug: 'api_tool_update', handler: { kind: 'builtin', ref: 'api_tool_update' } };

  it('dispatch refuses an in-brain turn before the tool runs', async () => {
    const res = await dispatchTool(
      row as never,
      { slug: 'x', enabled: true },
      {
        ownerId: 'owner-1',
        surface: { kind: 'web', loginId: LOGIN } as never,
        caller: turnCaller(),
      },
    );
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/a person's act/) });
  });

  // The check holds on every entry, for every value.
  it.each([
    ['a run item', runCaller(), { kind: 'owner', via: 'run' }],
    [
      'an app tool',
      appBrokerCaller({ kind: 'web' }, { ok: false, status: 403, reason: 'never asked' }),
      { kind: 'web' },
    ],
    ['a turn', turnCaller(), { kind: 'web', loginId: LOGIN }],
  ])('dispatch refuses %s every value but the one that tightens', async (_who, caller, surface) => {
    for (const requires_confirm of [0, 'no', {}, []]) {
      const res = await dispatchTool(
        row as never,
        { slug: 'x', requires_confirm },
        { ownerId: 'owner-1', surface: surface as never, caller },
      );
      expect(res, JSON.stringify(requires_confirm)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/a person's act/),
      });
    }
  });

  it.each([
    ['a turn', { surface: { kind: 'web' }, caller: turnCaller() }],
    ['an MCP client', { surface: { kind: 'owner', via: 'mcp' }, caller: { entry: 'mcp' } }],
    ['an API key', { surface: { kind: 'owner', via: 'api' }, caller: { entry: 'api-v1' } }],
    ['a peer', { surface: { kind: 'owner', via: 'federation' }, caller: { entry: 'mcp' } }],
    ['an app', { surface: { kind: 'web' }, caller: { entry: 'app' } }],
    ['a run', { surface: { kind: 'owner', via: 'run' }, caller: { entry: 'run' } }],
    // A person is decided by the caller alone.
    ['a surface that names the console', { surface: { kind: 'owner', via: 'dev-tools' } }],
    ['a surface that names a held call', { surface: { kind: 'owner', via: 'pending' } }],
  ])('%s is refused every value but the one that tightens', (_who, ctx) => {
    for (const a of PARAM_ROWS) {
      for (const value of [!a.agentValue, 0, 1, '', 'no', 'true', 'false', null, {}, []]) {
        expect(
          personOnlyRefusal(a.tool, { [a.param!]: value }, ctx as never),
          `${a.tool}.${a.param}=${JSON.stringify(value)}`,
        ).toMatch(/a person's act/);
      }
    }
  });

  it.each([
    ['the dev tool console', { surface: { kind: 'web' }, caller: ownerWebCaller() }],
    [
      'a held call a person approved',
      { surface: { kind: 'owner', via: 'pending' }, caller: pendingCaller({ approver: LOGIN }) },
    ],
  ])('%s passes', (_who, ctx) => {
    for (const a of PARAM_ROWS) {
      for (const value of [!a.agentValue, 0, 'no']) {
        expect(personOnlyRefusal(a.tool, { [a.param!]: value }, ctx as never), a.tool).toBeNull();
      }
    }
  });

  it('an agent may still tighten, and a param left out is no act', () => {
    const agent = { surface: { kind: 'web' }, caller: turnCaller() } as never;
    for (const args of [
      { requires_confirm: true },
      { enabled: false },
      { external_access: false },
      { requires_confirm: true, enabled: false, external_access: false },
      { requires_confirm: undefined },
      { url: 'https://example.test' },
    ]) {
      expect(personOnlyRefusal('api_tool_update', args, agent)).toBeNull();
    }
  });

  it('a tightening value does not carry a loosening one with it', () => {
    const agent = { surface: { kind: 'web' }, caller: turnCaller() } as never;
    expect(
      personOnlyRefusal('api_tool_update', { requires_confirm: true, enabled: 'yes' }, agent),
    ).toMatch(/enabled only as false/);
  });
});

/**
 * Looks like a gate, is not on the list. Each says why, in a line. A new tool
 * with such a param fails here until someone reads this rule.
 */
const LEVEL_CONFIRM =
  'who can see items, a rights rule and not a look at an agent (a key and a peer have it stripped)';
/** The owner's decision, 2026-11-07: not a gate. */
const FOLLOWS_RIGHTS = "no gate (owner, 2026-11-07): it follows the member's rights, as by hand";
/** The owner's decision, 2026-11-07. */
const MAKES_A_TOOL =
  'with toolsmithRequireApproval off the owner trusts agents to make tools, so an agent may delete a gated tool and make it again with no gate (owner, 2026-11-07); with it on, every new tool starts gated';
/** A group takes only what an agent may grant, then asks one door
 *  (packages/tools/src/toolsmith/common.ts groupListRefusal, heldGroupDoor). */
const GROUP_DOOR = "goes through groupListRefusal and heldGroupDoor, a group's list rule and door";
/** Names a group and adds no tool to it. */
const NAMES_A_GROUP = 'names a group; adds no tool to it';
const EXEMPT: Readonly<Record<string, string>> = {
  'tool_group_ensure.tool_slugs': GROUP_DOOR,
  'api_tool_create.group_slug': GROUP_DOOR,
  'api_tool_update.group_slug': GROUP_DOOR,
  'agent_grant_tool_group.group_slug': 'a grant of a whole group, parked for an in-brain agent',
  'api_docs_get.group_slug': NAMES_A_GROUP,
  'api_docs_set.group_slug': NAMES_A_GROUP,
  'api_skill_set.group_slug':
    "adds no tool; an in-brain agent's text on a group another workspace holds waits for a person (heldGroupDoor)",
  'sandbox_publish.group_slug': NAMES_A_GROUP,
  'app_tools_set.tool_slugs': "an app's declared tools, no tool group",
  'recall_map_delete.confirm': FOLLOWS_RIGHTS,
  app_publish: FOLLOWS_RIGHTS,
  page_commit: FOLLOWS_RIGHTS,
  table_commit: FOLLOWS_RIGHTS,
  'api_tool_create.requires_confirm': MAKES_A_TOOL,
  'recipe_tool_create.requires_confirm': MAKES_A_TOOL,
  'api_tool_update.read_only_confirmed': 'only with external_access: true, a row on the list',
  'api_key_set.needs_approval':
    'turning it off on a stored key is held for a person (held-tools.ts)',
  'app_timer_set.enabled': 'an app timer, no look at an agent',
  'gateway_service_set.enabled': 'a service switch, no look at an agent',
  'worker_group_ensure.enabled': 'a panel switch, no look at an agent',
  sandbox_publish: 'declares a port on a sandbox, no look at an agent',
  'file_copy.confirm': LEVEL_CONFIRM,
  'file_create.confirm': LEVEL_CONFIRM,
  'file_move.confirm': LEVEL_CONFIRM,
  'file_upload.confirm': LEVEL_CONFIRM,
  'folder_copy.confirm': LEVEL_CONFIRM,
  'folder_move.confirm': LEVEL_CONFIRM,
  'page_create.confirm': LEVEL_CONFIRM,
  'page_extract_section.confirm': LEVEL_CONFIRM,
  'page_from_file.confirm': LEVEL_CONFIRM,
  'page_from_journal.confirm': LEVEL_CONFIRM,
  'page_from_note.confirm': LEVEL_CONFIRM,
  'page_from_notes.confirm': LEVEL_CONFIRM,
  'page_move.confirm': LEVEL_CONFIRM,
  'page_split.confirm': LEVEL_CONFIRM,
  'present_export.confirm': LEVEL_CONFIRM,
  'speech_file_create.confirm': LEVEL_CONFIRM,
  'tree_folder_delete.confirm': LEVEL_CONFIRM,
  'tree_folder_update.confirm': LEVEL_CONFIRM,
  'tree_item_move.confirm': LEVEL_CONFIRM,
};

const GATE_PARAM =
  /requires_confirm|external_access|approv|confirm|publish|attest|^enabled$|^group_slug$|^tool_slugs$/i;
const GATE_NAME = /approv|confirm|publish|attest|commit/i;

describe('the sweep', () => {
  it('every param or name that looks like a gate, or changes a group, is on the list or stated exempt', async () => {
    const client = await clientOf((s) => registerMantleTools(s, 'owner-1', { transport: 'stdio' }));
    let listed: { name: string; inputSchema?: unknown }[];
    try {
      listed = (await client.listTools()).tools;
    } finally {
      await client.close();
    }
    // The MCP list and every builtin, an in-app agent's too.
    const schemas = new Map<string, unknown>();
    for (const t of BUILTIN_TOOLS) schemas.set(t.slug, t.inputSchema);
    for (const t of listed) schemas.set(t.name, t.inputSchema);

    const found: string[] = [];
    for (const [name, schema] of schemas) {
      if (GATE_NAME.test(name)) found.push(name);
      const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const param of Object.keys(props)) {
        if (GATE_PARAM.test(param)) found.push(`${name}.${param}`);
      }
    }
    const onTheList = new Set(PARAM_ROWS.map((a) => `${a.tool}.${a.param}`));
    const unknown = found.filter((key) => !onTheList.has(key) && !(key in EXEMPT));
    expect(unknown).toEqual([]);
    // A stale line goes when its tool or param goes.
    const stale = Object.keys(EXEMPT).filter((key) => !found.includes(key));
    expect(stale).toEqual([]);
    for (const [key, why] of Object.entries(EXEMPT)) {
      expect(why.length, key).toBeGreaterThan(10);
    }
  });
});
