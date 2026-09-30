/**
 * access_get / access_set (member logins Phase 0b): owner-side only, levels
 * validated, the content layer's refusals surface as tool errors.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  setItem: vi.fn(),
  sharedVia: vi.fn(),
  readThrough: vi.fn(async () => null),
}));
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    setItemLevel: h.setItem,
    sharedViaFolder: h.sharedVia,
    readThroughEmbeds: h.readThrough,
  };
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
      alsoLowered: [],
      stillAbove: [],
      raised: [],
      stillBelow: [],
    });
    const res = await access_set.handler(
      { node_id: 'n1', level: 'team', with_closure: true },
      OWNER,
    );
    expect(h.setItem).toHaveBeenCalledWith('o1', 'n1', 'team', {
      withClosure: true,
      raiseClosure: false,
    });
    expect(res.ok).toBe(true);
  });

  it('pass raise_closure through on its own (MED 7)', async () => {
    h.setItem.mockResolvedValueOnce({
      item: { id: 'n1' },
      lowered: [],
      alsoLowered: [],
      stillAbove: [],
      raised: [{ id: 'f1' }],
      stillBelow: [],
    });
    const res = await access_set.handler(
      { node_id: 'n1', level: 'admin', raise_closure: true },
      OWNER,
    );
    expect(h.setItem).toHaveBeenCalledWith('o1', 'n1', 'admin', {
      withClosure: false,
      raiseClosure: true,
    });
    expect(res.ok).toBe(true);
  });

  it('warn that a raise above a shared folder’s share leaves it read there', async () => {
    const done = {
      item: { id: 'n1', type: 'note' },
      lowered: [],
      alsoLowered: [],
      stillAbove: [],
      raised: [],
      stillBelow: [],
    };
    const via = { folderId: 'f1', trail: ['Clients', 'Acme'], level: 'client' };
    h.setItem.mockResolvedValueOnce(done);
    h.sharedVia.mockResolvedValueOnce(via);
    const up = await access_set.handler({ node_id: 'n1', level: 'admin' }, OWNER);
    expect(up.ok && (up.output as { warnings?: string[] }).warnings).toEqual([
      'It is still read at client: it sits in "Clients / Acme", a folder shared with clients. Move it out of that folder to hide it.',
    ]);
    // At or below the folder's share there is nothing to say.
    h.setItem.mockResolvedValueOnce(done);
    h.sharedVia.mockResolvedValueOnce(via);
    const same = await access_set.handler({ node_id: 'n1', level: 'client' }, OWNER);
    expect(same.ok && (same.output as { warnings?: string[] }).warnings).toBeUndefined();
  });

  it('warn that a raise above what embeds it leaves it read there (0208)', async () => {
    const done = {
      item: { id: 'n1', type: 'file' },
      lowered: [],
      alsoLowered: [],
      stillAbove: [],
      raised: [],
      stillBelow: [],
    };
    h.setItem.mockResolvedValueOnce(done);
    h.sharedVia.mockResolvedValueOnce(null);
    h.readThrough.mockResolvedValueOnce({
      level: 'client',
      via: [{ id: 'e1', title: 'Kickoff', type: 'note', level: 'client', through: 'folder' }],
    });
    const up = await access_set.handler({ node_id: 'n1', level: 'admin' }, OWNER);
    expect(up.ok && (up.output as { warnings?: string[] }).warnings).toEqual([
      "It is still read at client through what embeds it (the note 'Kickoff'). Take it out of those, or move them out of their shared folder, to hide it.",
    ]);
  });

  it('turn the type ceiling into a readable tool error', async () => {
    h.setItem.mockRejectedValueOnce(new AccessError('a journal is admin only', 'type_ceiling'));
    const res = await access_set.handler({ node_id: 'n1', level: 'team' }, OWNER);
    expect(res).toEqual({ ok: false, error: 'a journal is admin only' });
  });
});
