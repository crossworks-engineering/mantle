/**
 * The fail-closed branches (plan v3.2 S4b; S4a counted them as fail-open):
 * one cell per throw. Outside every scope the yes of scopeHoldsAdmin and
 * scopeHasArea is system work's, so with no system actor bound they throw;
 * a scoped typed write to a table the write role does not hold is refused
 * unless its matrix row names scopedSystemWrite (a login's write only);
 * an unlisted asSystem exit and an off-list systemDb caller in a turn
 * scope throw in production as in tests (viewer.test.ts holds those cells
 * too). No database: a refusal comes before any pool is asked for.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loginActor, runAsActor, runAsSystem, runWithoutActor, type Actor } from './actor';
import { closeDb } from './gateway/pools';
import { db } from './gateway/handles';
import { scopeHasArea, scopeHoldsAdmin } from './gateway/scope-answers';
import { actorCheckMisses, itemMarks, nodes } from './schema';
import {
  asSystem,
  assertSystemDbCaller,
  enterRequestScope,
  runInRequestSlot,
  runInTurnScope,
  SystemWorkRequiredError,
  TurnScopeExitError,
} from './viewer';

const LOGIN = '00000000-0000-4000-8000-0000000000c1';
const WS = '00000000-0000-4000-8000-0000000000c2';

afterAll(() => closeDb());

describe('scopeHoldsAdmin outside every scope', () => {
  it('no actor bound: throws', async () => {
    await runWithoutActor(async () => {
      await expect(scopeHoldsAdmin()).rejects.toBeInstanceOf(SystemWorkRequiredError);
    });
  });

  it('a login actor with no scope: throws', async () => {
    await runAsActor(loginActor(LOGIN), async () => {
      await expect(scopeHoldsAdmin()).rejects.toBeInstanceOf(SystemWorkRequiredError);
    });
  });

  it('a system actor: yes, the route that yes is for', async () => {
    await runAsSystem('worker:fail-closed-test', async () => {
      expect(await scopeHoldsAdmin()).toBe(true);
    });
  });
});

describe("scopeHasArea's system case", () => {
  it('no actor bound, or a login actor with no scope: throws', async () => {
    await runWithoutActor(async () => {
      await expect(scopeHasArea('users')).rejects.toBeInstanceOf(SystemWorkRequiredError);
    });
    await runAsActor(loginActor(LOGIN), async () => {
      await expect(scopeHasArea('settings')).rejects.toBeInstanceOf(SystemWorkRequiredError);
    });
  });

  it('a system actor: yes; an unknown area: no, before anything is asked', async () => {
    await runAsSystem('worker:fail-closed-test', async () => {
      expect(await scopeHasArea('users')).toBe(true);
    });
    await runWithoutActor(async () => {
      expect(await scopeHasArea('nope' as never)).toBe(false);
    });
  });
});

/** Run `fn` in a login's mutating request scope (W6a), as the session
 *  guard leaves it. */
function inWriteRequest<T>(fn: () => Promise<T>): Promise<T> {
  return runInRequestSlot(async () => {
    const scope = Object.freeze({
      kind: 'user' as const,
      loginId: LOGIN,
      ws: Object.freeze([WS]),
      modWs: Object.freeze([]),
    });
    expect(enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
    return fn();
  });
}

/** Whether `fn` is refused as a scoped system write. Any other error (no
 *  database in the unit run) is a write that was let through. */
function refused(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof SystemWorkRequiredError;
  }
}

describe('a scoped typed write to a table the write role does not hold', () => {
  it('refused, insert, update and delete alike, naming the table', async () => {
    await inWriteRequest(async () => {
      expect(refused(() => db.insert(actorCheckMisses))).toBe(true);
      expect(refused(() => db.update(actorCheckMisses))).toBe(true);
      expect(refused(() => db.delete(actorCheckMisses))).toBe(true);
      expect(() => db.delete(actorCheckMisses)).toThrow(/public\.actor_check_misses/);
    });
  });

  it('a write-role table goes to the write role; a write with no request scope is system work', async () => {
    await inWriteRequest(async () => {
      expect(refused(() => db.insert(nodes))).toBe(false);
    });
    await runAsSystem('worker:fail-closed-test', async () => {
      expect(refused(() => db.insert(actorCheckMisses))).toBe(false);
    });
  });

  it("a login's write to a table whose matrix row names scopedSystemWrite goes through", async () => {
    await inWriteRequest(async () => {
      expect(refused(() => db.insert(itemMarks))).toBe(false);
      expect(refused(() => db.update(itemMarks))).toBe(false);
    });
  });

  it("the reason covers a login only: an assistant's, a link's or a contact's write is refused", async () => {
    const others: Actor[] = [
      { kind: 'assistant', agentId: null },
      { kind: 'link' },
      { kind: 'contact', canWrite: true },
    ];
    for (const actor of others) {
      await inWriteRequest(() =>
        runAsActor(actor, async () => {
          expect(
            refused(() => db.insert(itemMarks)),
            actor.kind,
          ).toBe(true);
        }),
      );
    }
  });
});

describe('the turn scope fences in production', () => {
  const scope = Object.freeze({
    kind: 'assistant' as const,
    loginId: null,
    ws: Object.freeze([WS]),
    modWs: Object.freeze([]),
  });
  const inTurn = <T>(fn: () => Promise<T>) => runInTurnScope(scope, fn);
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = nodeEnv;
  });

  it('an unlisted asSystem exit throws', async () => {
    process.env.NODE_ENV = 'production';
    await expect(inTurn(() => asSystem(async () => 1, undefined as never))).rejects.toBeInstanceOf(
      TurnScopeExitError,
    );
  });

  it('an off-list systemDb caller throws', async () => {
    process.env.NODE_ENV = 'production';
    await expect(
      inTurn(async () => assertSystemDbCaller('Error\n    at f (/app/server/web/lib/x.ts:1:1)')),
    ).rejects.toBeInstanceOf(TurnScopeExitError);
  });
});
