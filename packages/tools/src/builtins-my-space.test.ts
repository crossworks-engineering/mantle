/**
 * Whom the "my space" tools act for (client logins C4). The login comes only
 * from the server-stamped surface: a member's team surface or a client's
 * client surface, each with its loginId. The owner (any owner surface), a
 * team surface without a login, and a missing surface have no one to act for
 * and are refused before any database work. The row-security side (what a
 * login's space shows) is pinned by builtins-my-space.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  execute: vi.fn(async () => [{ id: 'space-1' }]),
  withSpace: vi.fn(async (_scope: unknown, fn: () => Promise<unknown>) => fn()),
  listMine: vi.fn(async () => ({ items: [], total: 0 })),
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: { execute: h.execute },
  withSpace: h.withSpace,
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listMine: h.listMine,
}));

import { my_item_open, my_items_list } from './builtins-my-space';
import type { ToolHandlerContext } from './types';

const LOGIN = '00000000-0000-4000-8000-00000000000c';
const ctx = (surface: ToolHandlerContext['surface']): ToolHandlerContext => ({
  ownerId: 'o1',
  ...(surface ? { surface } : {}),
});

beforeEach(() => vi.clearAllMocks());

describe('my space acts for the login on the surface', () => {
  it.each([
    ['client', { kind: 'client' as const, loginId: LOGIN }],
    ['team member', { kind: 'team' as const, loginId: LOGIN }],
  ])('a %s login reads its own space', async (_n, surface) => {
    const res = await my_items_list.handler({}, ctx(surface));
    expect(res.ok).toBe(true);
    expect(h.withSpace).toHaveBeenCalledWith(
      { loginId: LOGIN, spaceId: 'space-1' },
      expect.any(Function),
    );
  });

  it.each([
    ['web owner', { kind: 'web' as const }],
    ['telegram owner', { kind: 'telegram' as const, telegramChatId: '42' }],
    ['owner/mcp', { kind: 'owner' as const, via: 'mcp' as const }],
    ['team without a login', { kind: 'team' as const, contactId: 'c1' }],
    ['missing', undefined],
  ])('a %s surface has no one to act for', async (_n, surface) => {
    for (const tool of [my_items_list, my_item_open]) {
      const res = await tool.handler({ id: LOGIN }, ctx(surface));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/No one to act for/);
    }
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.withSpace).not.toHaveBeenCalled();
  });
});
