/**
 * THE create-home intent (arch A3c), with the database stubbed: each way in
 * asks the one function, and each answers as it did before A3c (the HTTP
 * guard's ?ws=, an assistant turn's own workspace, an MCP create's
 * `workspace` argument, and the private fallback). The database half
 * (mantle_default_home, the private workspace) is pinned by the db tests
 * (w7b-mcp-surface, the sql grid, turn-create-home.db).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const W3 = '33333333-3333-4333-8333-333333333333';
const P1 = '44444444-4444-4444-8444-444444444444';
const LOGIN = '55555555-5555-4555-8555-555555555555';

const h = vi.hoisted(() => ({
  scope: null as null | { ws: string[]; modWs: string[] },
  rows: [] as { id: string; name: string; moderator?: boolean }[],
}));

vi.mock('./gateway/viewer-scope', () => ({
  loginScopeFor: vi.fn(async () => ({ kind: 'user', ws: [W1, W2], modWs: [W1] })),
  createHomeFallback: vi.fn(async () => ({ privateWs: P1 })),
}));
vi.mock('./gateway/handles', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => h.rows,
        innerJoin: () => ({ where: async () => h.rows }),
      }),
    }),
  },
}));
vi.mock('./viewer', () => ({ currentWorkspaceScope: () => h.scope }));

import { createHomeFallback, loginScopeFor } from './gateway/viewer-scope';
import { createHomeIntent } from './create-home';

beforeEach(() => {
  vi.mocked(createHomeFallback).mockClear();
  vi.mocked(loginScopeFor).mockClear();
  h.scope = null;
  h.rows = [];
});

describe('an id asked (an HTTP create ?ws=, an assistant turn)', () => {
  for (const from of ['param', 'assistant'] as const) {
    it(`${from}: moderated lands there, read only is as if none, not in it is refused`, async () => {
      const fb = { ownWork: false, makePrivate: true } as const;
      vi.mocked(createHomeFallback).mockResolvedValue({ privateWs: null });
      expect(await createHomeIntent(LOGIN, { from, ws: W1 }, fb)).toEqual({
        createWs: W1,
        privateWs: null,
      });
      expect(await createHomeIntent(LOGIN, { from, ws: W2.toUpperCase() }, fb)).toEqual({
        createWs: null,
        privateWs: null,
      });
      expect(await createHomeIntent(LOGIN, { from, ws: W3 }, fb)).toEqual({
        refused: 'not-member',
        message: 'You are not in that workspace.',
      });
      expect(await createHomeIntent(LOGIN, { from, ws: 'nope' }, fb)).toEqual({
        refused: 'invalid',
        message: 'ws must be a workspace id.',
      });
      for (const ws of [null, '']) {
        expect(await createHomeIntent(LOGIN, { from, ws }, fb)).toEqual({
          createWs: null,
          privateWs: null,
        });
      }
    });
  }

  it('a refusal of the ask makes no private workspace', async () => {
    await createHomeIntent(LOGIN, { from: 'param', ws: W3 }, { ownWork: true, makePrivate: true });
    expect(createHomeFallback).not.toHaveBeenCalled();
  });
});

describe('the fallback', () => {
  it('asked now: the private workspace, made when the call may make an item', async () => {
    vi.mocked(createHomeFallback).mockResolvedValueOnce({ privateWs: P1 });
    expect(await createHomeIntent(LOGIN, null, { ownWork: 'auto', makePrivate: true })).toEqual({
      createWs: null,
      privateWs: P1,
    });
    expect(createHomeFallback).toHaveBeenLastCalledWith(LOGIN, {
      ownWork: 'auto',
      makePrivate: true,
    });
  });

  it('no workspace to make one in: refused', async () => {
    const refused = { refused: 'no-workspace', message: 'You have no workspace to create in yet.' };
    vi.mocked(createHomeFallback).mockResolvedValueOnce(refused as never);
    expect(await createHomeIntent(LOGIN, null, { ownWork: true, makePrivate: true })).toEqual(
      refused,
    );
  });

  it('resolved once for a connection: no database call', async () => {
    expect(await createHomeIntent(LOGIN, null, { privateWs: P1 })).toEqual({
      createWs: null,
      privateWs: P1,
    });
    expect(await createHomeIntent(LOGIN, null, { privateWs: null })).toEqual({
      createWs: null,
      privateWs: null,
    });
    expect(createHomeFallback).not.toHaveBeenCalled();
    expect(loginScopeFor).not.toHaveBeenCalled();
  });
});

describe('an MCP create `workspace` argument (an id or a name)', () => {
  const fb = { privateWs: P1 };
  const ask = (workspace: unknown) => ({ from: 'argument' as const, workspace });

  it('in the call scope: by id or by name, a Moderator one only', async () => {
    h.scope = { ws: [W1, W2], modWs: [W1] };
    h.rows = [
      { id: W1, name: 'Research' },
      { id: W2, name: 'Sales' },
    ];
    expect(await createHomeIntent(LOGIN, ask(W1), fb)).toEqual({ createWs: W1, privateWs: P1 });
    expect(await createHomeIntent(LOGIN, ask('  research '), fb)).toEqual({
      createWs: W1,
      privateWs: P1,
    });
    expect(await createHomeIntent(LOGIN, ask('Sales'), fb)).toEqual({
      refused: 'not-moderator',
      message:
        'You are not a Moderator of Sales, so you cannot create in it. Pass a workspace whose moderator is true in workspaces_list, or leave workspace out.',
    });
    expect(await createHomeIntent(LOGIN, ask('Nowhere'), fb)).toEqual({
      refused: 'unknown',
      message:
        'You are not in a workspace "Nowhere". List yours with workspaces_list and pass one you moderate.',
    });
  });

  it('outside a scope: the login own user rows; a shared name asks for the id', async () => {
    h.rows = [
      { id: W1, name: 'Ops', moderator: true },
      { id: W2, name: 'ops', moderator: true },
    ];
    expect(await createHomeIntent(LOGIN, ask('OPS'), fb)).toEqual({
      refused: 'ambiguous',
      message:
        'More than one of your workspaces is called "OPS": pass its id from workspaces_list.',
    });
    expect(await createHomeIntent(LOGIN, ask(W2), fb)).toEqual({ createWs: W2, privateWs: P1 });
  });

  it('absent or blank: the fallback alone', async () => {
    for (const w of [undefined, null, '', '   ', 7]) {
      expect(await createHomeIntent(LOGIN, ask(w), fb)).toEqual({
        createWs: null,
        privateWs: P1,
      });
    }
  });
});
