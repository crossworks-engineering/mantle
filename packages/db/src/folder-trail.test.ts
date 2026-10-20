/**
 * Who gets the folders above what it reads (folder-trail.ts): a login's own
 * session only (a browser cookie, the phone's bearer token), never an API
 * key, a linked brain, a public link, a contact share, an assistant's turn,
 * an app, a process or an OAuth or stdio MCP client, and nothing outside a
 * call. For any other caller the read asks no definer at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const caller = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./gate', () => ({ currentCaller: () => caller.value }));
vi.mock('./client', () => ({
  db: {
    execute: () => {
      throw new Error('no definer may be asked here');
    },
  },
}));

const { folderTrail, folderTrailSql, trailForCaller } = await import('./folder-trail');

const login = { kind: 'login', mode: 'rw', loginId: '00000000-0000-4000-8000-000000000001' };
const owner = '00000000-0000-4000-8000-000000000002';

afterEach(() => {
  caller.value = null;
});

describe('the trail is for a login’s own session only', () => {
  it('a cookie or a bearer session of a login: yes', () => {
    for (const via of ['cookie', 'bearer']) {
      caller.value = { via, actor: login };
      expect(trailForCaller()).toBe(true);
      expect(folderTrailSql(owner, { under: 'notes' })).not.toBeNull();
    }
  });

  it('every other way in, or no login actor, or no call: no, and no definer is asked', async () => {
    const others = ['oauth', 'key', 'peer', 'link', 'contact', 'turn', 'app', 'process', 'stdio'];
    for (const via of others) {
      caller.value = { via, actor: login };
      expect(trailForCaller(), via).toBe(false);
      expect(folderTrailSql(owner, { under: 'notes' })).toBeNull();
      expect(await folderTrail(owner, { paths: ['notes.a'] })).toEqual([]);
    }
    for (const actor of [{ kind: 'assistant', agentId: null }, { kind: 'link' }, null]) {
      caller.value = { via: 'cookie', actor };
      expect(trailForCaller()).toBe(false);
    }
    caller.value = null;
    expect(trailForCaller()).toBe(false);
    expect(await folderTrail(owner, { folder: owner })).toEqual([]);
  });
});
