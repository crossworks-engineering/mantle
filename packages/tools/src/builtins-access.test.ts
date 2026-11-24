/**
 * access_get / access_set: owner-side only, and a brain item refused by
 * access_set (workspaces W5b2: items have no level, their grants are set in
 * Grant Access); agents and tool groups have none either since W7b.
 *
 * access_grant_add / access_grant_remove: who may call them (their policy,
 * the classes the gate and the turn loop read), and the refusals they give
 * before the panel's own rules run. The rules themselves, through the tool
 * and the route side by side: server/web/server/grants-mcp.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  access_get,
  access_grant_add,
  access_grant_remove,
  access_set,
  ACCESS_TOOLS,
  AGENT_LEVEL_GONE,
  GRANT_NEEDS_LOGIN,
  ITEM_LEVEL_GONE,
} from './builtins-access';
import type { ToolHandlerContext } from './types';

const OWNER: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'web' } };
const TEAM: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'team', contactId: 'c1' } };

describe('access tools', () => {
  it('refuse on a team surface', async () => {
    for (const tool of [access_get, access_set]) {
      const res = await tool.handler({ node_id: 'n1', level: 'team' }, TEAM);
      expect(res.ok).toBe(false);
    }
  });

  it('agents and tool groups have no level (W7b): access_set answers how instead', async () => {
    for (const input of [
      { agent_slug: 'a1', level: 'team' },
      { tool_group_slug: 'g1', level: 'admin' },
      {},
    ]) {
      expect(await access_set.handler(input, OWNER)).toEqual({
        ok: false,
        error: AGENT_LEVEL_GONE,
      });
    }
    expect(Object.keys(access_get.inputSchema.properties as object)).toEqual(['node_id']);
    expect(Object.keys(access_set.inputSchema.properties as object)).toEqual(['node_id']);
  });

  it('refuse to set a level on a brain item, pointing at Grant Access', async () => {
    for (const level of ['admin', 'team', 'public', 'everyone']) {
      const res = await access_set.handler({ node_id: 'n1', level }, OWNER);
      expect(res).toEqual({ ok: false, error: ITEM_LEVEL_GONE });
    }
    expect(ITEM_LEVEL_GONE).toMatch(/Grant Access/);
  });
});

describe('grant tools: who may call them', () => {
  const NODE = '11111111-1111-4111-8111-111111111111';

  it('widening is confirm-gated, narrowing is not', () => {
    // An in-brain turn's call of a confirm-gated tool waits in Pending
    // (the seeded tools row carries it: seed.ts); an MCP client acts at once.
    expect(access_grant_add.requiresConfirm).toBe(true);
    expect(access_grant_remove.requiresConfirm).toBeUndefined();
  });

  it('any login, by its own rights; a key or a peer only when named; no app, recipe or run item', () => {
    for (const def of [access_grant_add, access_grant_remove]) {
      expect(def.ownerOnly, def.slug).toBeUndefined();
      expect(def.mcpOnly, def.slug).toBeUndefined();
      expect(def.policy.scope, def.slug).toBe('any');
      expect(def.policy.effect, def.slug).toBe('write');
      expect(def.policy.peerRisky, def.slug).toBe(true);
      expect(def.policy.keyArea, def.slug).toBeUndefined();
      expect(def.policy.memberApp, def.slug).toBe('refused');
      expect(def.policy.recipe, def.slug).toEqual({ step: 'forbidden', runItem: 'banned' });
      expect(def.policy.itemArgs, def.slug).toEqual([{ param: 'node_id', least: 'read' }]);
    }
    // A client-sourced turn: a widening always waits; a narrowing waits
    // when the item is one clients read.
    expect(access_grant_add.policy.clientSourced).toMatchObject({ kind: 'always' });
    expect(access_grant_remove.policy.clientSourced).toEqual({ kind: 'write', nodes: ['node_id'] });
    expect(ACCESS_TOOLS.map((t) => t.slug)).toEqual([
      'access_get',
      'access_set',
      'access_grant_add',
      'access_grant_remove',
    ]);
  });

  it('acts for a login only: with no login scope (the admin channel) it refuses', async () => {
    for (const def of [access_grant_add, access_grant_remove]) {
      const res = await def.handler({ node_id: NODE, workspace: 'Proj' }, OWNER);
      expect(res, def.slug).toEqual({ ok: false, error: GRANT_NEEDS_LOGIN });
    }
  });

  it('names what is missing and where to find it', async () => {
    for (const def of [access_grant_add, access_grant_remove]) {
      const noNode = await def.handler({ workspace: 'Proj' }, OWNER);
      expect(noNode.ok).toBe(false);
      expect((noNode as { error: string }).error).toMatch(/node_id is required.*search_nodes/);
      const noWs = await def.handler({ node_id: NODE }, OWNER);
      expect((noWs as { error: string }).error).toMatch(/workspace is required.*workspaces_list/);
    }
  });

  it('the retired tools point at the new ones', () => {
    expect(ITEM_LEVEL_GONE).toMatch(/access_grant_add/);
    expect(ITEM_LEVEL_GONE).toMatch(/access_grant_remove/);
    expect(access_get.description).toMatch(/access_grant_add/);
    expect(access_get.description).not.toMatch(/changed in the item's Grant Access panel/);
    expect(access_set.description).toMatch(/access_grant_remove/);
  });
});

// The behaviour the destructive and confirm-gated sweep asks of each
// (destructive-coverage.test.ts): both arms through the handler; the panel's
// rules themselves in server/web/server/grants-mcp.db.test.ts.
const NODE2 = '22222222-2222-4222-8222-222222222222';
const bothArms = async (def: (typeof ACCESS_TOOLS)[number]) => {
  expect(await def.handler({ node_id: NODE2, workspace: 'Proj' }, OWNER)).toEqual({
    ok: false,
    error: GRANT_NEEDS_LOGIN,
  });
  const bare = await def.handler({ node_id: NODE2 }, OWNER);
  expect(bare).toMatchObject({ ok: false, error: expect.stringMatching(/workspace is required/) });
};

describe('access_grant_add (widens: confirm-gated)', () => {
  it('refuses with no login to act for, and teaches a missing argument', async () => {
    await bothArms(ACCESS_TOOLS.find((t) => t.slug === 'access_grant_add')!);
  });
});

describe('access_grant_remove (narrows)', () => {
  it('refuses with no login to act for, and teaches a missing argument', async () => {
    await bothArms(ACCESS_TOOLS.find((t) => t.slug === 'access_grant_remove')!);
  });
});
