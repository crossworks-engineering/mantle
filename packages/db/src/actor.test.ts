/**
 * The actor kinds and how code binds them (workspaces arch A2a, actor.ts).
 * No database: the binding is AsyncLocalStorage.
 */
import { describe, expect, it } from 'vitest';
import {
  actorSetting,
  currentActor,
  loginActor,
  runAsActor,
  runAsSystem,
  runInActorSlot,
  runReadPathWrite,
  runWithoutActor,
  setSlotActor,
  systemActor,
  writeModeOf,
  READ_PATH_WRITES,
  TEST_ACTOR,
  type Actor,
} from './actor';
import { asSystem, runInViewerScope, type WorkspaceScope } from './viewer';

const L = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';

describe('the actor kinds (plan 4.1, 20.3 item 15)', () => {
  it('each kind has its setting and its write mode', () => {
    const rows: [Actor, string, 'rw' | 'ro'][] = [
      [loginActor(L, 'rw'), `login:rw:${L}`, 'rw'],
      [loginActor(L, 'ro'), `login:ro:${L}`, 'ro'],
      [loginActor(L, 'owner'), `login:owner:${L}`, 'rw'],
      [{ kind: 'assistant', agentId: null }, 'assistant:none', 'ro'],
      [{ kind: 'link' }, 'link', 'ro'],
      [{ kind: 'contact', canWrite: true }, 'contact:rw', 'rw'],
      [{ kind: 'contact', canWrite: false }, 'contact:ro', 'ro'],
      [systemActor('worker:extract'), 'system:worker:extract', 'rw'],
      [{ kind: 'peer', peerId: null }, 'peer:none', 'ro'],
    ];
    for (const [actor, setting, mode] of rows) {
      expect(actorSetting(actor)).toBe(setting);
      expect(writeModeOf(actor)).toBe(mode);
    }
  });

  it('refuses a login that is not a uuid and a reason that is not one', () => {
    expect(() => loginActor('owner')).toThrow();
    expect(() => systemActor('Worker Extract')).toThrow();
  });
});

describe('binding the actor', () => {
  it('a test runs as system(test), its own process entry (vitest.setup.ts)', () => {
    expect(currentActor()).toEqual(TEST_ACTOR);
  });

  it('an inner binding replaces an outer one, and leaves with it', async () => {
    expect(currentActor()).toEqual(TEST_ACTOR);
    await runAsSystem('outer', async () => {
      expect(currentActor()).toEqual(systemActor('outer'));
      await runAsActor(loginActor(L), async () => {
        expect(currentActor()).toEqual(loginActor(L));
      });
      expect(currentActor()).toEqual(systemActor('outer'));
    });
    expect(currentActor()).toEqual(TEST_ACTOR);
  });

  it('an entry slot starts as given and is named later; an outer binding does not reach in', () => {
    runAsSystem('outer', () =>
      runInActorSlot(systemActor('http:no-login'), () => {
        expect(currentActor()).toEqual(systemActor('http:no-login'));
        setSlotActor(loginActor(L, 'ro'));
        expect(currentActor()).toEqual(loginActor(L, 'ro'));
        // A binding inside the slot still wins.
        runAsSystem('inner', () => expect(currentActor()).toEqual(systemActor('inner')));
      }),
    );
    setSlotActor(loginActor(L)); // outside a slot: nothing
    expect(currentActor()).toEqual(TEST_ACTOR);
  });

  it('runWithoutActor starts with none, as an entry does', () => {
    runAsSystem('outer', () => runWithoutActor(() => expect(currentActor()).toBeNull()));
  });

  it('asSystem runs as system(reason)', async () => {
    await runAsActor(loginActor(L), () =>
      asSystem(
        async () => expect(currentActor()).toEqual(systemActor('login-notice')),
        'login-notice',
      ),
    );
  });

  it('a read-path write runs as system(its name), every name a repair or a backfill', async () => {
    await runAsActor(loginActor(L, 'ro'), () =>
      runReadPathWrite('backfill:page-block-ids', async () => {
        expect(currentActor()).toEqual(systemActor('backfill:page-block-ids'));
        expect(writeModeOf(currentActor()!)).toBe('rw');
      }),
    );
    for (const name of Object.keys(READ_PATH_WRITES)) {
      expect(name).toMatch(/^(repair|backfill):[a-z0-9-]+$/);
    }
  });

  it('a workspace scope runs as its login, keeping the mode the caller named', async () => {
    const scope = (loginId: string | null, kind: WorkspaceScope['kind'] = 'user') =>
      Object.freeze({ kind, loginId, ws: Object.freeze([W]), modWs: Object.freeze([]) });
    await runInViewerScope(scope(L), async () => {
      expect(currentActor()).toEqual(loginActor(L, 'rw'));
    });
    await runAsActor(loginActor(L, 'ro'), () =>
      runInViewerScope(scope(L), async () => {
        expect(currentActor()).toEqual(loginActor(L, 'ro'));
      }),
    );
    await runInViewerScope(scope(null, 'assistant'), async () => {
      expect(currentActor()).toEqual({ kind: 'assistant', agentId: null });
    });
    await runAsActor(loginActor(L, 'owner'), () =>
      runInViewerScope(scope(null, 'assistant'), async () => {
        expect(currentActor()).toEqual(loginActor(L, 'owner'));
      }),
    );
    await runInViewerScope(scope(null, 'link'), async () => {
      expect(currentActor()).toEqual({ kind: 'link' });
    });
  });

  it('a lazy thenable returned from a binding starts inside it', async () => {
    let seen: Actor | null = null;
    const lazy = {
      then(ok: (v: string) => unknown) {
        seen = currentActor();
        return Promise.resolve('done').then(ok);
      },
    };
    await expect(runAsSystem('lazy', () => lazy)).resolves.toBe('done');
    expect(seen).toEqual(systemActor('lazy'));
  });
});
