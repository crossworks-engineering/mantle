/**
 * access_get / access_set (member logins Phase 0b): owner-side only, levels
 * validated, the content layer's refusals surface as tool errors.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ setItem: vi.fn() }));
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, setItemAudience: h.setItem };
});

import { AccessError } from '@mantle/content';
import { access_get, access_set } from './builtins-access';
import type { ToolHandlerContext } from './types';

const OWNER: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'web' } };
const TEAM: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'team', contactId: 'c1' } };

describe('access tools', () => {
  it('refuse on a team surface', async () => {
    for (const tool of [access_get, access_set]) {
      const res = await tool.handler({ node_id: 'n1', level: 'team' }, TEAM);
      expect(res.ok).toBe(false);
    }
    expect(h.setItem).not.toHaveBeenCalled();
  });

  it('refuse a value that is not a level', async () => {
    const res = await access_set.handler({ node_id: 'n1', level: 'everyone' }, OWNER);
    expect(res.ok === false && res.error).toMatch(/admin, team, client, public/);
  });

  it('pass with_closure through and return what was lowered', async () => {
    h.setItem.mockResolvedValueOnce({
      item: { id: 'n1' },
      lowered: [{ id: 'f1' }],
      stillAbove: [],
    });
    const res = await access_set.handler(
      { node_id: 'n1', level: 'team', with_closure: true },
      OWNER,
    );
    expect(h.setItem).toHaveBeenCalledWith('o1', 'n1', 'team', { withClosure: true });
    expect(res.ok).toBe(true);
  });

  it('turn the type ceiling into a readable tool error', async () => {
    h.setItem.mockRejectedValueOnce(new AccessError('a journal is admin only', 'type_ceiling'));
    const res = await access_set.handler({ node_id: 'n1', level: 'team' }, OWNER);
    expect(res).toEqual({ ok: false, error: 'a journal is admin only' });
  });
});
