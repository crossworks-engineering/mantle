/**
 * registerActorWorkflow (workspaces arch A2a, M2/M4): the API boot binds no
 * actor, so a workflow starts with none; the helper runs each run as the
 * actor its `actorOf` names, from the run's own arguments. DBOS is a double:
 * registerWorkflow hands back the function it is given.
 */
import { describe, expect, it, vi } from 'vitest';
import { currentActor, loginActor, runWithoutActor, systemActor, type Actor } from '@mantle/db';

const h = vi.hoisted(() => ({ registered: [] as { name: string }[] }));

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    registerWorkflow: <T>(fn: T, opts: { name: string }) => {
      h.registered.push({ name: opts.name });
      return fn;
    },
  },
}));

import { registerActorWorkflow, systemEntry } from './actor-workflow';

const LOGIN = '00000000-0000-4000-8000-000000000001';

describe('registerActorWorkflow (arch A2a)', () => {
  it('registers under the name, and runs as the actor of the run’s arguments', async () => {
    const asked: (Actor | null)[] = [];
    const wf = registerActorWorkflow(
      'testActorWorkflow',
      async (input: { loginId: string }, _n: number) => {
        asked.push(currentActor());
        return loginActor(input.loginId, 'rw');
      },
      async (input: { loginId: string }, n: number) => ({ actor: currentActor(), input, n }),
    );
    expect(h.registered.map((r) => r.name)).toContain('testActorWorkflow');
    const out = await runWithoutActor(() => wf({ loginId: LOGIN }, 7));
    // actorOf runs with no actor: a lookup it makes binds its own.
    expect(asked).toEqual([null]);
    expect(out).toEqual({ actor: loginActor(LOGIN, 'rw'), input: { loginId: LOGIN }, n: 7 });
  });

  it('systemEntry: the runner’s own work as system(reason), after an await too', async () => {
    const wf = registerActorWorkflow(
      'testSystemWorkflow',
      systemEntry('workflow:test'),
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentActor();
      },
    );
    expect(await runWithoutActor(() => wf())).toEqual(systemActor('workflow:test'));
  });

  it('an impl that throws rejects the run, as DBOS expects', async () => {
    const wf = registerActorWorkflow(
      'testThrowWorkflow',
      systemEntry('workflow:test'),
      async () => {
        throw new Error('boom');
      },
    );
    await expect(runWithoutActor(() => wf())).rejects.toThrow('boom');
  });
});
