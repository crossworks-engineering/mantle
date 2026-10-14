/**
 * A run item's third-party result is read fenced (A5 step 6a, carried L4):
 * execute-item.ts stores `untrusted: true` with the result of a tool whose
 * result the tool loop fences, the compiled state carries it per item, and
 * runStateUntrusted says whether a model that reads the state must read it
 * fenced (run_state and run_plan answer `untrusted`; the resume turn fences
 * the state it puts in its prompt).
 */
import { describe, expect, it } from 'vitest';
import { runs } from '@mantle/db';
import { compileRunState, renderRunStateText, runStateUntrusted } from './state';

const RUN = '11111111-1111-4111-8111-111111111111';

function item(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    runId: RUN,
    parentId: 'root',
    kind: 'tool_call',
    state: 'done',
    position: 1,
    payload: { tool: 'web_fetch', args: { url: 'u' } },
    result: { output: 'page text' },
    costMicroUsd: 0,
    sideEffecting: false,
    evidenceRefs: null,
    agentId: null,
    traceRef: null,
    supersededBy: null,
    startedAt: null,
    finishedAt: null,
    deadlineAt: null,
    joinPolicy: null,
    childrenDone: 0,
    childrenTotal: 0,
    createdAt: new Date(0),
    ...over,
  };
}

/** A database that answers the run and its items. */
function fakeDb(rows: ReturnType<typeof item>[]) {
  const run = {
    id: RUN,
    ownerId: 'o',
    title: 'probe',
    status: 'done',
    agentId: null,
    originTurnId: null,
    createdAt: new Date(0),
    completedAt: null,
    budgetMicroUsd: null,
    spentMicroUsd: 0,
    originChannel: null,
    rootItemId: 'root',
  };
  const root = item('root', {
    parentId: null,
    kind: 'group_seq',
    payload: {},
    result: null,
    position: 0,
  });
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const all = table === runs ? [run] : [root, ...rows];
          return Object.assign(Promise.resolve(all), {
            orderBy: () => Promise.resolve(all),
          });
        },
      }),
    }),
  } as never;
}

describe('a run item that returned third-party content', () => {
  it('is marked in the compiled state, and the run reads untrusted', async () => {
    const compiled = (await compileRunState(
      fakeDb([item('a', { result: { output: 'page text', untrusted: true } })]),
      RUN,
    ))!;
    expect(compiled.tree?.children?.[0]?.untrusted).toBe(true);
    expect(runStateUntrusted(compiled)).toBe(true);
    // The rendered text is unchanged: the reader fences it whole.
    expect(renderRunStateText(compiled)).toContain('→ page text');
  });

  it('a run whose items returned none reads as before', async () => {
    const compiled = (await compileRunState(fakeDb([item('a')]), RUN))!;
    expect(compiled.tree?.children?.[0]?.untrusted).toBeUndefined();
    expect(runStateUntrusted(compiled)).toBe(false);
  });
});
