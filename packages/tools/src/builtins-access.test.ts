/**
 * access_get / access_set: owner-side only, and a brain item refused by
 * access_set (workspaces W5b2: items have no level, their grants are set in
 * Grant Access); agents and tool groups have none either since W7b.
 */
import { describe, expect, it } from 'vitest';
import { access_get, access_set, AGENT_LEVEL_GONE, ITEM_LEVEL_GONE } from './builtins-access';
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
