/**
 * turnCreateHome's own rules (A0 fix round 2, L-3), with the database
 * stubbed: a failure is not kept for the rest of the turn, and only a
 * create may make the login's private workspace.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: { kind: 'assistant', loginId: 'l1', ws: ['w1'], modWs: [] } as Record<string, unknown>,
}));

vi.mock('@mantle/db', () => ({
  currentCreateHome: vi.fn(() => null),
  createHomeIntent: vi.fn(),
}));
vi.mock('@mantle/db/viewer', () => ({ currentWorkspaceScope: () => h.scope }));

import { createHomeIntent } from '@mantle/db';
import { turnCreateHome } from './turn-create-home';

beforeEach(() => {
  vi.mocked(createHomeIntent).mockReset();
  h.scope = { kind: 'assistant', loginId: 'l1', ws: ['w1'], modWs: [] };
});

describe('turnCreateHome', () => {
  it('does not keep a database error: the next call resolves again', async () => {
    vi.mocked(createHomeIntent).mockRejectedValueOnce(new Error('db down'));
    expect(await turnCreateHome(false)).toBeNull();
    vi.mocked(createHomeIntent).mockResolvedValueOnce({ createWs: null, privateWs: 'p1' });
    expect(await turnCreateHome(false)).toEqual({ createWs: null, privateWs: 'p1' });
    expect(createHomeIntent).toHaveBeenCalledTimes(2);
  });

  it('makes the private workspace only for a create, then keeps the home', async () => {
    vi.mocked(createHomeIntent).mockResolvedValueOnce({ createWs: null, privateWs: null });
    expect(await turnCreateHome(false)).toEqual({ createWs: null, privateWs: null });
    expect(createHomeIntent).toHaveBeenLastCalledWith(
      'l1',
      { from: 'assistant', ws: 'w1' },
      { ownWork: 'auto', makePrivate: false },
    );
    // A second read keeps it; a create asks again, making it.
    expect(await turnCreateHome(false)).toEqual({ createWs: null, privateWs: null });
    vi.mocked(createHomeIntent).mockResolvedValueOnce({ createWs: null, privateWs: 'p1' });
    expect(await turnCreateHome(true)).toEqual({ createWs: null, privateWs: 'p1' });
    expect(createHomeIntent).toHaveBeenLastCalledWith(
      'l1',
      { from: 'assistant', ws: 'w1' },
      { ownWork: 'auto', makePrivate: true },
    );
    expect(await turnCreateHome(true)).toEqual({ createWs: null, privateWs: 'p1' });
    expect(createHomeIntent).toHaveBeenCalledTimes(2);
  });

  it('names no home outside an assistant turn that names a login', async () => {
    for (const scope of [
      { kind: 'user', loginId: 'l1', ws: ['w1'], modWs: [] },
      { kind: 'assistant', loginId: null, ws: ['w1'], modWs: [] },
    ]) {
      h.scope = scope;
      expect(await turnCreateHome(true)).toBeNull();
    }
    expect(createHomeIntent).not.toHaveBeenCalled();
  });
});
