/**
 * What an assistant turn lists (A5 step 5, owner pick B, turn-listing.ts):
 * only the tools the one gate lets the turn call in its scope. An owner
 * turn (an Admin scope with every area) lists every builtin and every
 * runtime row with a policy, as before; a member turn in a workspace that
 * is not Admin no longer lists an Admin-only tool, an Admin-area tool, a
 * create of an Admin-only kind or a shell tool, and still lists the rest.
 * The scope and the Admin view are stubbed (no database), and so are the
 * item rights the item pre-check reads (an item only an Admin scope may
 * change) and the preconditions' node lookups.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: null as null | Record<string, unknown>,
  view: { holdsAdmin: false, areas: new Set<string>() },
  /** The item only a scope that holds the Admin workspace may change. */
  adminItem: '33333333-3333-4333-8333-333333333333',
  /** The scopes the item rights were asked in. */
  itemAsked: [] as Array<Record<string, unknown> | null>,
  /** The connector's resource rows: held by every workspace of the scope
   *  (`held`), with its Write tick (`write`). */
  connector: { held: true, write: true },
}));

vi.mock('../../db/src/viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/src/viewer')>();
  return {
    ...real,
    currentWorkspaceScope: () => h.scope ?? real.currentWorkspaceScope(),
  };
});
vi.mock('../../db/src/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/src/client')>()),
  scopeHoldsAdmin: async () => h.view.holdsAdmin,
  scopeHasArea: async (a: string) => h.view.holdsAdmin && h.view.areas.has(a),
}));

// The item rights (the database's mantle_may_edit / mantle_may_manage), as
// the scope reads them: the Admin item is changed only from a scope that
// holds Admin; any other item, by anyone.
vi.mock('../../db/src/item-rights', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/src/item-rights')>();
  return {
    ...real,
    itemWriteRefusalOf: async (ids: readonly string[], need: 'read' | 'edit' | 'manage') => {
      h.itemAsked.push(h.scope);
      if (!h.scope || need === 'read') return null;
      const id = ids.find((i) => i === h.adminItem);
      if (!id || h.view.holdsAdmin) return null;
      return { message: real.itemNoRightError(id, need), detail: 'no_edit' as const };
    },
  };
});
// A precondition's node lookup reads the database: every id names a node
// of the kind the tool asks for.
// The connector's resource rows (A5 step 6a, carried L1: the connector
// narrower reads them): the connector is a resource of every workspace,
// with its Write tick, so a Moderator there may call a write.
vi.mock('./external-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./external-access')>()),
  connectorGroupOf: async (_owner: string, row: { handler: { group?: string } }) => ({
    id: 'g',
    slug: row.handler.group,
    usable: true,
  }),
  connectorResources: async (_owner: string, _group: string, ws: readonly string[]) =>
    h.connector.held ? ws.map((workspaceId) => ({ workspaceId, write: h.connector.write })) : [],
}));
// A Recall map by its slug (A5 step 6a, carried round-2 LOW-1): only
// `known` names a map the scope reads.
vi.mock('./builtins-recall-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./builtins-recall-write')>()),
  mapRef: async (_ownerId: string, ref: string) =>
    ref === 'known' ? { id: 'map-node', version: 1, slug: 'known' } : null,
}));
vi.mock('./preconditions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./preconditions')>()),
  checkToolPreconditions: async () => null,
}));

import { itemNoRightError, loginActor, runAsActor, type Tool } from '@mantle/db';
import { BUILTIN_TOOLS, ensureGateReady, turnCallRefusal, turnListedTools } from './index';
import {
  CONNECTOR_ELEVATED_REASON,
  CONNECTOR_NOT_HELD_ERROR,
  CONNECTOR_WRITE_ERROR,
  type ElevatedApproval,
} from './connector-scope';
import { NO_RUNTIME_POLICY_ERROR } from './runtime-policy';
import { OWNER_ONLY_ERROR } from './surface';
import type { TurnListingFacts } from './turn-listing';

const OWNER = '99999999-9999-4999-8999-999999999999';
const LOGIN = '55555555-5555-4555-8555-555555555555';
const ADMIN_WS = '11111111-1111-4111-8111-111111111111';
const TEAM_WS = '22222222-2222-4222-8222-222222222222';
const AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys'];

const builtinRow = (slug: string) =>
  ({
    slug,
    ownerId: OWNER,
    handler: { kind: 'builtin', ref: slug },
    requiresConfirm: false,
    inputSchema: { type: 'object', properties: {} },
  }) as unknown as Tool;

const runtime = (slug: string, handler: Record<string, unknown>) =>
  ({
    slug,
    ownerId: OWNER,
    handler,
    requiresConfirm: false,
    externalAccess: null,
    description: slug,
    inputSchema: { type: 'object', properties: {} },
  }) as unknown as Tool;

const RUNTIME = [
  runtime('crm_lookup', { kind: 'mcp', group: 'crm', toolName: 'lookup' }),
  runtime('api_get', { kind: 'http', url: 'https://api.example.test/v1', method: 'GET' }),
  runtime('a_recipe', { kind: 'recipe', steps: [{ tool: 'search_nodes' }] }),
  runtime('shell_echo', { kind: 'shell', cmd: 'echo hi' }),
];
const NO_POLICY = runtime('odd', { kind: 'carrier-pigeon' });

const ROWS = [...BUILTIN_TOOLS.map((d) => builtinRow(d.slug)), ...RUNTIME, NO_POLICY];

async function listedIn(
  scope: Record<string, unknown>,
  view: { holdsAdmin: boolean; areas: Set<string> },
  surface: TurnListingFacts['surface'] = { kind: 'web' },
): Promise<string[]> {
  h.scope = scope;
  h.view = view;
  try {
    return (
      await runAsActor(loginActor(LOGIN), () => turnListedTools(ROWS, { ownerId: OWNER, surface }))
    ).map((t) => t.slug);
  } finally {
    h.scope = null;
  }
}

describe('the turn listing is the gate listing (A5 step 5, pick B)', () => {
  ensureGateReady();

  it('an owner turn lists every builtin and every runtime row with a policy, as before', async () => {
    const listed = await listedIn(
      { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS], modWs: [ADMIN_WS] },
      { holdsAdmin: true, areas: new Set(AREAS) },
    );
    // A row with no policy was never callable (the gate's step 3 refuses
    // it); it is the one row the owner's list leaves out.
    expect(listed).toEqual(ROWS.filter((r) => r !== NO_POLICY).map((r) => r.slug));
  });

  it('a member turn in a workspace that is not Admin hides exactly the Admin-only, admin-kind, Admin-area, shell and unwritable connector tools', async () => {
    const listed = new Set(
      await listedIn(
        { kind: 'assistant', loginId: LOGIN, ws: [TEAM_WS], modWs: [] },
        { holdsAdmin: false, areas: new Set() },
      ),
    );
    const scopeOf = (s: (typeof BUILTIN_TOOLS)[number]['policy']['scope']) =>
      typeof s === 'object' ? 'area' : s;
    const hiddenBuiltins = BUILTIN_TOOLS.filter((d) => !listed.has(d.slug));
    // Every hidden builtin is of one of the three Admin classes, and every
    // builtin of those classes is hidden. (An ownerOnly tool of scope `any`
    // is listed: the turn's surface is the owner's here.)
    expect(new Set(hiddenBuiltins.map((d) => scopeOf(d.policy.scope)))).toEqual(
      new Set(['admin', 'admin-kind', 'area']),
    );
    for (const d of BUILTIN_TOOLS) {
      const adminClass = scopeOf(d.policy.scope) !== 'any';
      expect(listed.has(d.slug), d.slug).toBe(!adminClass);
    }
    for (const slug of ['model_pool_list', 'contact_create', 'journal_create', 'location_save']) {
      expect(listed.has(slug), slug).toBe(false);
    }
    // Of the runtime rows: the connector's write row (its connector holds
    // Write, but the member is no Moderator: A5 step 6a, carried L1, where
    // before it was listed and dispatch refused it), the shell row (Q2) and
    // the row with no policy.
    expect(RUNTIME.filter((r) => !listed.has(r.slug)).map((r) => r.slug)).toEqual([
      'crm_lookup',
      'shell_echo',
    ]);
    expect(listed.has('odd')).toBe(false);
  });

  it('off the owner surface an owner-only tool is not listed (A5 step 6a, carried L1)', async () => {
    const owner = { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS], modWs: [ADMIN_WS] };
    const view = { holdsAdmin: true, areas: new Set(AREAS) };
    const onOwner = new Set(await listedIn(owner, view, { kind: 'web' }));
    const offOwner = new Set(
      await listedIn(owner, view, { kind: 'team', privateReads: false } as never),
    );
    const hidden = [...onOwner].filter((s) => !offOwner.has(s)).sort();
    // Exactly the owner-only builtins, tree_folders among them (scope any:
    // listed before and refused at dispatch).
    expect(hidden).toEqual(
      BUILTIN_TOOLS.filter((d) => d.ownerOnly)
        .map((d) => d.slug)
        .sort(),
    );
    expect(hidden).toContain('tree_folders');
    expect([...offOwner].filter((s) => !onOwner.has(s))).toEqual([]);
  });
});

/** The refusal the gate gives a loop's queued call in `scope`. */
async function refusalIn(
  scope: Record<string, unknown>,
  view: { holdsAdmin: boolean; areas: Set<string> },
  tool: Tool,
  surface: Parameters<typeof turnCallRefusal>[2]['surface'] = { kind: 'web' },
  input: Record<string, unknown> = {},
): Promise<string | null> {
  h.scope = scope;
  h.view = view;
  try {
    return await runAsActor(loginActor(LOGIN), () =>
      turnCallRefusal(tool, input, { ownerId: OWNER, surface }),
    );
  } finally {
    h.scope = null;
  }
}

describe('a call that needs approval meets the gate before it is queued (A5 step 5 fix round 1, M2)', () => {
  ensureGateReady();
  const member = { kind: 'assistant', loginId: LOGIN, ws: [TEAM_WS], modWs: [] };
  const memberView = () => ({ holdsAdmin: false, areas: new Set<string>() });
  const owner = { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS], modWs: [ADMIN_WS] };
  const ownerView = () => ({ holdsAdmin: true, areas: new Set(AREAS) });
  const shell = RUNTIME.find((r) => r.slug === 'shell_echo')!;

  it('a workspace heartbeat outside Admin may not queue telegram_send (connectors area)', async () => {
    const refused = await refusalIn(member, memberView(), builtinRow('telegram_send'), {
      kind: 'team',
      privateReads: false,
    } as never);
    expect(refused).toBeTruthy();
    expect(refused).not.toBe(OWNER_ONLY_ERROR);
  });

  it('a member turn outside Admin may not queue a shell row', async () => {
    expect(await refusalIn(member, memberView(), shell)).toBeTruthy();
  });

  it('a row with no policy is refused in the words dispatch uses', async () => {
    expect(await refusalIn(owner, ownerView(), NO_POLICY)).toBe(NO_RUNTIME_POLICY_ERROR);
  });

  it('an owner-only tool is refused off an owner surface, in its own words', async () => {
    const ownerOnly = BUILTIN_TOOLS.find((d) => d.ownerOnly)!;
    expect(
      await refusalIn(owner, ownerView(), builtinRow(ownerOnly.slug), {
        kind: 'team',
        privateReads: false,
      } as never),
    ).toBe(OWNER_ONLY_ERROR);
  });

  it("what the scope may call still queues: the owner's telegram_send and shell row, a member's note", async () => {
    expect(await refusalIn(owner, ownerView(), builtinRow('telegram_send'))).toBeNull();
    expect(await refusalIn(owner, ownerView(), shell)).toBeNull();
    expect(await refusalIn(member, memberView(), builtinRow('note_create'))).toBeNull();
  });

  it('a Recall map named by a slug the scope does not read is refused before it is queued (round-2 LOW-1)', async () => {
    const refused = await refusalIn(
      member,
      memberView(),
      builtinRow('recall_card_put'),
      undefined,
      {
        map: 'secret',
      },
    );
    expect(refused).toMatch(/^Recall map 'secret' is not one in your workspaces/);
  });

  it('the refusal agrees with the listing for every tool, in both scopes and on both surfaces', async () => {
    const team = { kind: 'team', privateReads: false } as never;
    for (const [scope, view] of [
      [member, memberView],
      [owner, ownerView],
    ] as const) {
      for (const [surface, ownerSurface] of [
        [{ kind: 'web' } as never, true],
        [team, false],
      ] as const) {
        // The same surface the call is asked on (one rule, fix round 1,
        // LOW-3).
        const listed = new Set(await listedIn(scope, view(), surface));
        for (const row of ROWS) {
          const refused = await refusalIn(scope, view(), row, surface);
          expect(refused === null, `${row.slug} ${String(ownerSurface)}`).toBe(
            listed.has(row.slug),
          );
        }
      }
    }
  });
});

describe("a call that needs approval meets the gate's item pre-check before it is queued (A5 step 5 fix round 2)", () => {
  ensureGateReady();
  const team = { kind: 'assistant', loginId: null, ws: [TEAM_WS], modWs: [TEAM_WS] };
  const teamView = () => ({ holdsAdmin: false, areas: new Set<string>() });
  const owner = { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS], modWs: [ADMIN_WS] };
  const ownerView = () => ({ holdsAdmin: true, areas: new Set(AREAS) });
  const teamSurface = { kind: 'team', privateReads: false } as never;
  const MINE = '44444444-4444-4444-8444-444444444444';

  it('a workspace heartbeat outside Admin may not queue a delete or a share of an item only Admin may change', async () => {
    for (const [slug, args] of [
      ['page_delete', { id: h.adminItem }],
      ['table_delete', { id: h.adminItem }],
      ['node_share', { id: h.adminItem, level: 'public' }],
    ] as const) {
      h.itemAsked = [];
      const refused = await refusalIn(team, teamView(), builtinRow(slug), teamSurface, args);
      // The words dispatch answers (the item pre-check's own), asked in the
      // turn's own scope, never the approver's.
      expect(refused, slug).toBe(
        itemNoRightError(h.adminItem, slug === 'node_share' ? 'edit' : 'manage'),
      );
      expect(h.itemAsked, slug).toEqual([team]);
    }
  });

  it('an item the turn may change still queues', async () => {
    expect(
      await refusalIn(team, teamView(), builtinRow('page_delete'), teamSurface, { id: MINE }),
    ).toBeNull();
  });

  it('an owner (Admin) heartbeat still queues a delete of the Admin item, as before', async () => {
    expect(
      await refusalIn(
        owner,
        ownerView(),
        builtinRow('page_delete'),
        { kind: 'web' },
        {
          id: h.adminItem,
        },
      ),
    ).toBeNull();
    expect(
      await refusalIn(
        owner,
        ownerView(),
        builtinRow('node_share'),
        { kind: 'web' },
        {
          id: h.adminItem,
          level: 'public',
        },
      ),
    ).toBeNull();
  });
});

describe('a connector write the scope may not make itself, when its call waits for approval (owner decision 1a, A5 step 6d)', () => {
  ensureGateReady();
  const member = { kind: 'assistant', loginId: LOGIN, ws: [TEAM_WS], modWs: [] };
  const moderator = { kind: 'assistant', loginId: LOGIN, ws: [TEAM_WS], modWs: [TEAM_WS] };
  const view = () => ({ holdsAdmin: false, areas: new Set<string>() });
  const lookup = RUNTIME.find((r) => r.slug === 'crm_lookup')!;
  const confirmed = {
    ...runtime('crm_update', { kind: 'mcp', group: 'crm', toolName: 'update' }),
    requiresConfirm: true,
  } as Tool;
  const rows = [lookup, confirmed];

  const listed = async (
    scope: Record<string, unknown>,
    facts: { queuesWrites?: boolean } = {},
  ): Promise<string[]> => {
    h.scope = scope;
    h.view = view();
    try {
      return (
        await runAsActor(loginActor(LOGIN), () =>
          turnListedTools(rows, { ownerId: OWNER, surface: { kind: 'web' }, ...facts }),
        )
      ).map((t) => t.slug);
    } finally {
      h.scope = null;
    }
  };

  const queued = async (scope: Record<string, unknown>, tool: Tool) => {
    h.scope = scope;
    h.view = view();
    const queue: { elevated: ElevatedApproval | null } = { elevated: null };
    try {
      const refused = await runAsActor(loginActor(LOGIN), () =>
        turnCallRefusal(tool, {}, { ownerId: OWNER, surface: { kind: 'web' } }, queue),
      );
      return { refused, elevated: queue.elevated };
    } finally {
      h.scope = null;
    }
  };

  const reset = () => {
    h.connector = { held: true, write: true };
  };

  it('not a Moderator: the requires_confirm write is offered, the one that would run directly stays hidden', async () => {
    reset();
    expect(await listed(member)).toEqual(['crm_update']);
  });

  it('the Write tick off: the same, even for a Moderator', async () => {
    h.connector = { held: true, write: false };
    try {
      expect(await listed(moderator)).toEqual(['crm_update']);
    } finally {
      reset();
    }
  });

  it('a loop whose writes all wait (client-sourced) is offered both', async () => {
    reset();
    expect(await listed(member, { queuesWrites: true })).toEqual(['crm_lookup', 'crm_update']);
  });

  it('queued, the call is let through with the elevated field; asked without the queue it is refused as before', async () => {
    reset();
    expect(await queued(member, confirmed)).toEqual({
      refused: null,
      elevated: { elevated: true, reason: CONNECTOR_ELEVATED_REASON },
    });
    h.scope = member;
    h.view = view();
    try {
      expect(
        await runAsActor(loginActor(LOGIN), () =>
          turnCallRefusal(confirmed, {}, { ownerId: OWNER, surface: { kind: 'web' } }),
        ),
      ).toBe(CONNECTOR_WRITE_ERROR);
    } finally {
      h.scope = null;
    }
  });

  it('a scope that may make the write queues it with its own rights: no elevated field', async () => {
    reset();
    expect(await queued(moderator, confirmed)).toEqual({ refused: null, elevated: null });
    expect(await listed(moderator)).toEqual(['crm_lookup', 'crm_update']);
  });

  it('only the write rule is lifted: a connector the scope does not hold is neither offered nor queued', async () => {
    h.connector = { held: false, write: true };
    try {
      expect(await listed(member, { queuesWrites: true })).toEqual([]);
      expect(await queued(member, confirmed)).toEqual({
        refused: CONNECTOR_NOT_HELD_ERROR,
        elevated: null,
      });
    } finally {
      reset();
    }
  });

  it('listing equals queuing: a waiting call is offered exactly when it queues', async () => {
    for (const write of [true, false]) {
      h.connector = { held: true, write };
      for (const scope of [member, moderator]) {
        const offered = new Set(await listed(scope));
        for (const row of rows.filter((r) => r.requiresConfirm)) {
          const { refused } = await queued(scope, row);
          expect(refused === null, `${row.slug} write=${String(write)}`).toBe(
            offered.has(row.slug),
          );
        }
      }
    }
    reset();
  });
});
