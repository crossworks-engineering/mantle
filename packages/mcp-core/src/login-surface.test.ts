/**
 * The owner surface a PEER gets when its token acts as the owner (plan page
 * e5b854dd): read-only unless the peer's write switch is on, and never the
 * risky tools unless the owner named them. Driven through the real
 * registration path against a capturing fake server; no database, no model.
 * Since W7b every login has this surface: what a scope lists is pinned
 * below; the DB-backed sweep is server/web/server/w7b-mcp-surface.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '@mantle/tools';
import type { Tool, ToolHandler } from '@mantle/db';
import { externalAccessToolSig } from '@mantle/tools';
import { registerMantleTools } from './build-server';
import {
  MCP_NO_WORKSPACE_INSTRUCTIONS,
  mcpInstructionsFor,
  preparedLists,
  registerPreparedTools,
  type McpCaller,
  type PreparedCallerTools,
} from './login-surface';
import {
  ADMIN_KIND_CREATE_TOOL_SLUGS,
  isMcpToolReadOnly,
  isPeerRiskyTool,
  MCP_CREATE_TOOL_SLUGS,
  MCP_HANDWRITTEN_READ_ONLY,
  OWNER_KEY_SPENDING_TOOLS,
  OWNER_ONLY_IN_SCOPE,
  spendsOwnerKeys,
} from './policy-views.test-helper';

/** What the surface registers: the anchor's own (no connection), or a
 *  peer's, listed through the one gate (A5 step 4). */
function registered(peer?: { write: boolean; riskyAllowed?: readonly string[] }): string[] {
  const out: string[] = [];
  const fakeServer = { registerTool: (name: string) => void out.push(name) };
  if (!peer) {
    registerMantleTools(fakeServer as never, 'owner-1', { transport: 'http' });
    return out;
  }
  registerPreparedTools(fakeServer as never, {
    kind: 'owner',
    caller: {
      role: 'admin',
      anchorId: 'owner-1',
      loginId: 'login-1',
      via: 'peer',
      write: peer.write,
      riskyAllowed: peer.riskyAllowed ?? [],
    },
    view: null,
    privateWs: null,
    connectors: [],
  });
  return out;
}

describe('owner surface for a peer', () => {
  it('the hand-written read set names only tools the surface registers', () => {
    const all = registered();
    for (const s of MCP_HANDWRITTEN_READ_ONLY) expect(all).toContain(s);
    // The hand-written writes and spenders are not in it.
    for (const s of ['file_rename', 'folder_rename', 'folder_describe', 'ask_responder']) {
      expect(isMcpToolReadOnly(s), s).toBe(false);
    }
  });

  it('write off: registers only read-only tools, and no risky one', () => {
    const tools = registered({ write: false });
    expect(tools.length).toBeGreaterThan(20);
    for (const s of tools) {
      expect(isMcpToolReadOnly(s), s).toBe(true);
      expect(isPeerRiskyTool(s), s).toBe(false);
    }
    expect(tools).toContain('search');
    expect(tools).toContain('file_read');
    expect(tools).not.toContain('file_upload');
    expect(tools).not.toContain('note_create');
  });

  it('write on: adds the write tools but keeps the risky ones out', () => {
    const tools = registered({ write: true });
    for (const s of ['file_upload', 'note_create', 'event_create', 'folder_create']) {
      expect(tools).toContain(s);
    }
    for (const s of [
      'email_send',
      'app_publish',
      'node_share',
      'telegram_send',
      'sandbox_exec',
      'web_search',
      'invoke_agent',
      'secret_create',
      'access_set',
      'pending_approve',
      'agent_grant_tool_group',
      // audit 2026-10-03: runs, mail by page, the allowlist, confirm-gated
      // deletes, live app code, third-brain egress, model routing
      'run_plan',
      'run_append',
      'email_page',
      'contact_create',
      'page_delete',
      'app_source_set',
      'app_tools_set',
      'peer_call',
      'peer_file_copy',
      'model_pool_set',
    ]) {
      expect(tools, s).not.toContain(s);
    }
  });

  it('a risky tool comes back only when the owner names it', () => {
    const tools = registered({ write: true, riskyAllowed: ['email_send'] });
    expect(tools).toContain('email_send');
    expect(tools).not.toContain('telegram_send');
  });

  it('every spending or confirm-gated builtin counts as risky', () => {
    for (const d of BUILTIN_TOOLS) {
      if (d.spends || d.requiresConfirm) expect(isPeerRiskyTool(d.slug), d.slug).toBe(true);
    }
  });

  it('write off: no peer egress either', () => {
    const tools = registered({ write: false });
    expect(tools.filter((s) => s.startsWith('peer_'))).toEqual([]);
  });
});

describe('one surface for every login (W7b): what a scope lists', () => {
  const member: McpCaller = {
    role: 'member',
    anchorId: 'a',
    loginId: 'l',
    via: 'oauth',
    write: true,
  };
  const prep = (
    caller: McpCaller,
    view: { holdsAdmin: boolean; areas: string[] } | null,
  ): PreparedCallerTools => ({
    kind: 'owner',
    caller,
    view: view ? { holdsAdmin: view.holdsAdmin, areas: new Set(view.areas as never[]) } : null,
    privateWs: null,
    connectors: [],
  });
  const ALL_AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys'];
  const ITEM_TOOLS = [
    'note_create',
    'page_create',
    'table_create',
    'file_upload',
    'app_create',
    'app_file_write',
    'app_publish',
    'tree_folder_create',
    'page_move',
    'workspaces_list',
    'app_data_list',
    'app_data_write',
    'search',
  ];
  const ADMIN_ONLY = [
    'replay_window',
    'run_plan',
    'pending_approve',
    'set_timezone',
    'responder_turn_record',
    'access_set',
    'recall_map_publish',
    'content_supersede',
  ];
  const AREA = ['model_pool_set', 'agent_list', 'peer_call', 'secret_create', 'email_send'];

  it('a scope without Admin: item tools listed, adminOnly and Admin-area tools not', () => {
    const p = prep(member, { holdsAdmin: false, areas: [] });
    for (const s of ITEM_TOOLS) expect(preparedLists(p, s), s).toBe(true);
    for (const s of [...ADMIN_ONLY, ...AREA]) expect(preparedLists(p, s), s).toBe(false);
  });

  it('a scope holding Admin: adminOnly tools listed, an area tool only with its area on', () => {
    const full = prep({ ...member, role: 'admin' }, { holdsAdmin: true, areas: ALL_AREAS });
    for (const s of [...ITEM_TOOLS, ...ADMIN_ONLY, ...AREA]) {
      expect(preparedLists(full, s), s).toBe(true);
    }
    const noAreas = prep({ ...member, role: 'admin' }, { holdsAdmin: true, areas: [] });
    for (const s of ADMIN_ONLY) expect(preparedLists(noAreas, s), s).toBe(true);
    for (const s of AREA) expect(preparedLists(noAreas, s), s).toBe(false);
  });

  it('every ownerOnly builtin is adminOnly unless it is an item tool that runs in scope', () => {
    const p = prep(member, { holdsAdmin: false, areas: [] });
    for (const d of BUILTIN_TOOLS) {
      if (!d.ownerOnly) continue;
      expect(preparedLists(p, d.slug), d.slug).toBe(OWNER_ONLY_IN_SCOPE.has(d.slug));
    }
  });

  it('a member key or peer is narrowed like an admin one: write switch and risky tools', () => {
    const view = { holdsAdmin: false, areas: [] };
    const key = prep({ ...member, via: 'key', write: false, areas: null }, view);
    expect(preparedLists(key, 'search')).toBe(true);
    expect(preparedLists(key, 'note_create')).toBe(false);
    const peerRw = prep({ ...member, via: 'peer', write: true, riskyAllowed: [] }, view);
    expect(preparedLists(peerRw, 'note_create')).toBe(true);
    // App code changes are risky for a peer or a key (a published app runs them).
    expect(preparedLists(peerRw, 'app_file_write')).toBe(false);
    expect(preparedLists(peerRw, 'replay_window')).toBe(false);
  });

  it('a refused caller lists nothing', () => {
    const refused: PreparedCallerTools = { kind: 'refused', caller: member, message: 'x' };
    expect(preparedLists(refused, 'search')).toBe(false);
  });

  it('every login is told about its workspaces and where a create lands', () => {
    for (const role of ['admin', 'member'] as const) {
      const text = mcpInstructionsFor({ ...member, role });
      expect(text).toContain('workspaces_list');
      expect(text).toContain('landedIn');
      expect(text).not.toMatch(/my_app_|my_note_create|team_request_create/);
    }
  });

  // W7b fix round 1.
  const SPENDING = [
    'web_search_pro',
    'web_search',
    'generate_image',
    'summarize_text',
    'process_extraction',
    'invoke_agent',
    'ask_responder',
    'ask_as_responder',
  ];

  it('M4: outside Admin nothing that spends on the owner’s keys is listed', () => {
    const p = prep(member, { holdsAdmin: false, areas: [] });
    for (const s of SPENDING) {
      expect(spendsOwnerKeys(s), s).toBe(true);
      expect(preparedLists(p, s), s).toBe(false);
    }
    for (const d of BUILTIN_TOOLS.filter((x) => x.spends && x.slug !== 'search_chunks')) {
      expect(preparedLists(p, d.slug), d.slug).toBe(false);
    }
    // The query embedding of a passage search is not a paid turn.
    expect(preparedLists(p, 'search_chunks')).toBe(true);
    // A scope holding Admin keeps them (subject to its areas).
    const admin = prep({ ...member, role: 'admin' }, { holdsAdmin: true, areas: ALL_AREAS });
    for (const s of ['web_search_pro', 'generate_image', 'summarize_text', 'invoke_agent']) {
      expect(preparedLists(admin, s), s).toBe(true);
    }
    for (const s of OWNER_KEY_SPENDING_TOOLS) expect(spendsOwnerKeys(s), s).toBe(true);
    // The owner's Mapbox key (W7 integration fix 2, M4).
    expect(spendsOwnerKeys('route_map')).toBe(true);
    expect(preparedLists(p, 'route_map')).toBe(false);
    expect(preparedLists(admin, 'route_map')).toBe(true);
  });

  it('H2: outside Admin no Admin-only kind is created; task, event and map creates land by the rule', () => {
    const p = prep(member, { holdsAdmin: false, areas: [] });
    for (const s of ADMIN_KIND_CREATE_TOOL_SLUGS) expect(preparedLists(p, s), s).toBe(false);
    for (const s of ['contact_create', 'journal_create', 'location_save']) {
      expect(ADMIN_KIND_CREATE_TOOL_SLUGS.has(s), s).toBe(true);
    }
    for (const s of ['task_create', 'event_create', 'recall_map_create']) {
      expect(MCP_CREATE_TOOL_SLUGS.has(s), s).toBe(true);
      expect(preparedLists(p, s), s).toBe(true);
    }
    const admin = prep({ ...member, role: 'admin' }, { holdsAdmin: true, areas: ALL_AREAS });
    for (const s of ADMIN_KIND_CREATE_TOOL_SLUGS) expect(preparedLists(admin, s), s).toBe(true);
  });

  it('H1: run_terminal is listed for no scope without Admin and the settings area', () => {
    expect(
      preparedLists(prep(member, { holdsAdmin: false, areas: ALL_AREAS }), 'run_terminal'),
    ).toBe(false);
    expect(preparedLists(prep(member, { holdsAdmin: true, areas: [] }), 'run_terminal')).toBe(
      false,
    );
  });

  it('M3: a read-only OAuth grant lists only the tools that read', () => {
    const p = prep({ ...member, write: false }, { holdsAdmin: false, areas: [] });
    const listed: string[] = [];
    registerPreparedTools({ registerTool: (n: string) => void listed.push(n) } as never, p);
    expect(listed.length).toBeGreaterThan(20);
    for (const s of listed) expect(isMcpToolReadOnly(s), s).toBe(true);
    expect(listed).not.toContain('note_create');
  });

  it('the member tool sets are gone from the registry (W7b)', () => {
    for (const slug of [
      'my_app_create',
      'my_app_list',
      'team_request_create',
      'team_chat_list',
      'team_chat_read',
      'team_access_list',
    ]) {
      expect(
        BUILTIN_TOOLS.some((d) => d.slug === slug),
        slug,
      ).toBe(false);
    }
  });

  it('a read-only connection keeps the read-only connector tools it was given (W7 integration fix 2)', () => {
    // A connector row is listed by its own policy (the gate, A5 step 4): one
    // the admin marked read-only reads, one unmarked writes; the registry
    // knows no connector slug, so a name no row of the connection carries
    // is listed for no one.
    const row = (toolName: string) =>
      ({
        slug: `mcp_crm_${toolName}`,
        description: 'crm',
        inputSchema: { type: 'object', properties: {} },
        handler: { kind: 'mcp', group: 'crm', toolName } satisfies ToolHandler,
        requiresConfirm: false,
        externalAccess: null,
      }) as unknown as Tool;
    const list = row('contacts_list');
    const marked = {
      ...list,
      externalAccess: {
        confirmedReadOnlyAt: new Date(0).toISOString(),
        by: { via: 'web' },
        handlerSig: externalAccessToolSig(list),
      },
    } as Tool;
    const p = {
      ...prep({ ...member, write: false }, { holdsAdmin: false, areas: [] }),
      connectors: [marked, row('contacts_update')],
    } as PreparedCallerTools;
    expect(preparedLists(p, 'mcp_crm_contacts_list')).toBe(true);
    expect(preparedLists(p, 'mcp_crm_contacts_update')).toBe(false);
    expect(preparedLists(p, 'mcp_crm_other')).toBe(false);
    // Builtins still read only.
    expect(preparedLists(p, 'note_create')).toBe(false);
    expect(preparedLists(p, 'note_list')).toBe(true);
  });
});

describe('a login in no workspace lists no tools (A5 step 4, owner decision A)', () => {
  const LONE = '00000000-0000-4000-8000-0000000000d1';
  const W = '10000000-0000-4000-8000-000000000002';
  const caller: McpCaller = {
    role: 'member',
    anchorId: 'a',
    loginId: LONE,
    via: 'oauth',
    write: true,
  };
  const prepared = (ws: string[]): PreparedCallerTools => ({
    kind: 'owner',
    caller,
    view: { holdsAdmin: false, areas: new Set() },
    privateWs: null,
    connectors: [],
    scope: { kind: 'user', loginId: LONE, ws, modWs: [] },
  });
  const listed = (p: PreparedCallerTools) => {
    const out: string[] = [];
    registerPreparedTools({ registerTool: (n: string) => void out.push(n) } as never, p);
    return out;
  };

  it('lists nothing, and the server instructions say why', () => {
    const none = prepared([]);
    expect(listed(none)).toEqual([]);
    for (const s of ['search', 'note_list', 'workspaces_list']) {
      expect(preparedLists(none, s), s).toBe(false);
    }
    const text = mcpInstructionsFor(caller, none);
    expect(text).toBe(MCP_NO_WORKSPACE_INSTRUCTIONS);
    expect(text).toMatch(/user of no workspace/);
    expect(text).toMatch(/lists no tools/);
    expect(text).not.toContain('recall_match');
  });

  it('the same login in a workspace lists its tools and is told about its workspaces', () => {
    const one = prepared([W]);
    expect(listed(one).length).toBeGreaterThan(100);
    expect(preparedLists(one, 'search')).toBe(true);
    expect(mcpInstructionsFor(caller, one)).toContain('workspaces_list');
    // A connection prepared before its scope was read (absent) lists as before.
    const { scope: _scope, ...unread } = one as PreparedCallerTools & { scope?: unknown };
    expect(listed(unread as PreparedCallerTools).length).toBe(listed(one).length);
    expect(mcpInstructionsFor(caller)).toContain('workspaces_list');
  });
});
