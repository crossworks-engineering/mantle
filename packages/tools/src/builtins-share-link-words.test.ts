/**
 * The link tools' queue-time words (LINK_ITEM_ARG): a refusal of an item
 * whose link only its home's Moderators open (an app, a Present canvas:
 * linkNeedsModerator) names that rule; any other item's names the edit
 * right. The item's type is read from a stand-in for the nodes row.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ type: 'present' as string | null }));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (h.type === null ? [] : [{ type: h.type }]) }),
      }),
    }),
  },
}));

import { LINK_NO_EDIT_MESSAGE, LINK_NO_MANAGE_MESSAGE } from '@mantle/content';
import { LINK_ITEM_ARG } from './builtins-share';

const refused = (detail: 'no_read' | 'no_edit') => LINK_ITEM_ARG[0]!.refused!(detail, 'id-1');

describe('the link tools name the rule they refuse by', () => {
  it('a canvas and an app: only a Moderator of the home workspace', async () => {
    for (const type of ['present', 'app']) {
      h.type = type;
      expect(await refused('no_edit')).toBe(LINK_NO_MANAGE_MESSAGE);
    }
    expect(LINK_NO_MANAGE_MESSAGE).toMatch(/Moderator of this item's home workspace/);
  });

  it('any other item: whoever may edit it; one the scope does not read: not found', async () => {
    h.type = 'note';
    expect(await refused('no_edit')).toBe(LINK_NO_EDIT_MESSAGE);
    h.type = null;
    expect(await refused('no_edit')).toBe(LINK_NO_EDIT_MESSAGE);
    expect(await refused('no_read')).toMatch(/not found/);
  });
});
