/**
 * access_get / access_set: owner-side only, levels validated, and a brain
 * item refused by access_set (workspaces W5b2: items have no level, their
 * grants are set in Grant Access).
 */
import { describe, expect, it } from 'vitest';
import { access_get, access_set, ITEM_LEVEL_GONE } from './builtins-access';
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

  it('refuse a value that is not a level', async () => {
    const res = await access_set.handler({ agent_slug: 'a1', level: 'everyone' }, OWNER);
    expect(res.ok === false && res.error).toMatch(/admin, team, client, public/);
  });

  it('refuse to set a level on a brain item, pointing at Grant Access', async () => {
    for (const level of ['admin', 'team', 'public', 'everyone']) {
      const res = await access_set.handler({ node_id: 'n1', level }, OWNER);
      expect(res).toEqual({ ok: false, error: ITEM_LEVEL_GONE });
    }
    expect(ITEM_LEVEL_GONE).toMatch(/Grant Access/);
  });
});
