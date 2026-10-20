/**
 * Who gets the folders above what it reads (folder-trail.ts): a login's own
 * session only (a browser cookie, the phone's bearer token), never an API
 * key, a linked brain, a public link, a contact share, an assistant's turn,
 * an app, a process or an OAuth or stdio MCP client, and nothing outside a
 * call; and only in a workspace scope of that login (the owner, unscoped,
 * reads every folder and asks nothing). For any other caller the read asks
 * no definer at all. The exact paths go as one text[] parameter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const caller = vi.hoisted(() => ({ value: null as unknown, scope: null as unknown }));
vi.mock('./gate', () => ({ currentCaller: () => caller.value }));
vi.mock('./viewer', () => ({ currentWorkspaceScope: () => caller.scope }));
vi.mock('./client', () => ({
  db: {
    execute: () => {
      throw new Error('no definer may be asked here');
    },
  },
}));

const { folderTrail, folderTrailSql, textArraySql, trailForCaller } =
  await import('./folder-trail');
const { PgDialect } = await import('drizzle-orm/pg-core');

const login = { kind: 'login', mode: 'rw', loginId: '00000000-0000-4000-8000-000000000001' };
const owner = '00000000-0000-4000-8000-000000000002';

const scope = { kind: 'user', loginId: login.loginId, ws: ['w'], modWs: [] };

afterEach(() => {
  caller.value = null;
  caller.scope = null;
});

describe('the trail is for a login’s own session only', () => {
  it('a cookie or a bearer session of a login in its workspace scope: yes', () => {
    caller.scope = scope;
    for (const via of ['cookie', 'bearer']) {
      caller.value = { via, actor: login };
      expect(trailForCaller(owner)).toBe(true);
      expect(folderTrailSql(owner, { under: 'notes' })).not.toBeNull();
    }
  });

  it('the owner, a session with no workspace scope, or a scope with no login: no, and no definer is asked', async () => {
    caller.scope = scope;
    caller.value = { via: 'cookie', actor: { ...login, loginId: owner } };
    expect(trailForCaller(owner)).toBe(false);
    expect(trailForCaller(owner.toUpperCase())).toBe(false);
    for (const [s, mode] of [
      [scope, 'owner'],
      [null, 'owner'],
      [null, 'rw'],
      [{ ...scope, loginId: null }, 'rw'],
    ] as const) {
      caller.scope = s;
      for (const via of ['cookie', 'bearer']) {
        caller.value = { via, actor: { ...login, mode } };
        expect(trailForCaller(owner)).toBe(false);
        expect(folderTrailSql(owner, { under: 'notes' })).toBeNull();
        expect(await folderTrail(owner, { paths: ['notes.a'] })).toEqual([]);
      }
    }
  });

  it('every other way in, or no login actor, or no call: no, and no definer is asked', async () => {
    caller.scope = scope;
    const others = ['oauth', 'key', 'peer', 'link', 'contact', 'turn', 'app', 'process', 'stdio'];
    for (const via of others) {
      caller.value = { via, actor: login };
      expect(trailForCaller(owner), via).toBe(false);
      expect(folderTrailSql(owner, { under: 'notes' })).toBeNull();
      expect(await folderTrail(owner, { paths: ['notes.a'] })).toEqual([]);
    }
    for (const actor of [{ kind: 'assistant', agentId: null }, { kind: 'link' }, null]) {
      caller.value = { via: 'cookie', actor };
      expect(trailForCaller(owner)).toBe(false);
    }
    caller.value = null;
    expect(trailForCaller(owner)).toBe(false);
    expect(await folderTrail(owner, { folder: owner })).toEqual([]);
  });
});

describe('the exact paths are one parameter', () => {
  it('70,000 paths bind as one text[] (no bind limit), quoted as array elements', () => {
    caller.scope = scope;
    caller.value = { via: 'cookie', actor: login };
    const paths = Array.from({ length: 70_000 }, (_, i) => `files.f${i}`);
    const q = new PgDialect().sqlToQuery(folderTrailSql(owner, { paths })!);
    expect(q.params).toHaveLength(4);
    expect(q.params[2]).toBe(`{${paths.map((p) => `"${p}"`).join(',')}}`);
    const odd = new PgDialect().sqlToQuery(textArraySql(['a"b', 'c\\d', 'e,f']));
    expect(odd.params).toEqual(['{"a\\"b","c\\\\d","e,f"}']);
  });
});
