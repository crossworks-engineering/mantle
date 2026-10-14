/**
 * What an assistant turn lists (A5 step 5, owner pick B, turn-listing.ts):
 * only the tools the one gate lets the turn call in its scope. An owner
 * turn (an Admin scope with every area) lists every builtin and every
 * runtime row with a policy, as before; a member turn in a workspace that
 * is not Admin no longer lists an Admin-only tool, an Admin-area tool, a
 * create of an Admin-only kind or a shell tool, and still lists the rest.
 * The scope and the Admin view are stubbed (no database).
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: null as null | Record<string, unknown>,
  view: { holdsAdmin: false, areas: new Set<string>() },
}));

vi.mock('../../db/src/viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/src/viewer')>();
  return {
    ...real,
    currentWorkspaceScope: () => h.scope ?? real.currentWorkspaceScope(),
    currentGateScope: () => null,
  };
});
vi.mock('../../db/src/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/src/client')>()),
  scopeHoldsAdmin: async () => h.view.holdsAdmin,
  scopeHasArea: async (a: string) => h.view.holdsAdmin && h.view.areas.has(a),
}));

import { loginActor, runAsActor, type Tool } from '@mantle/db';
import { BUILTIN_TOOLS, ensureGateReady, turnListedTools } from './index';

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
): Promise<string[]> {
  h.scope = scope;
  h.view = view;
  try {
    return (await runAsActor(loginActor(LOGIN), () => turnListedTools(ROWS))).map((t) => t.slug);
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

  it('a member turn in a workspace that is not Admin lists no Admin-only tool', async () => {
    const listed = new Set(
      await listedIn(
        { kind: 'assistant', loginId: LOGIN, ws: [TEAM_WS], modWs: [] },
        { holdsAdmin: false, areas: new Set() },
      ),
    );
    let hidden = 0;
    for (const def of BUILTIN_TOOLS) {
      const scope = def.policy.scope;
      const adminOnly =
        scope === 'admin' || scope === 'admin-kind' || typeof scope === 'object' || !!def.ownerOnly;
      if (adminOnly) {
        if (!listed.has(def.slug)) hidden += 1;
        continue;
      }
      expect(listed.has(def.slug), def.slug).toBe(true);
    }
    expect(hidden).toBeGreaterThan(20);
    for (const slug of ['model_pool_list', 'contact_create', 'journal_create', 'location_save']) {
      expect(listed.has(slug), slug).toBe(false);
    }
    expect(listed.has('shell_echo')).toBe(false);
    expect(listed.has('odd')).toBe(false);
    for (const slug of ['crm_lookup', 'api_get', 'a_recipe', 'note_create', 'search_nodes']) {
      expect(listed.has(slug), slug).toBe(true);
    }
  });
});
