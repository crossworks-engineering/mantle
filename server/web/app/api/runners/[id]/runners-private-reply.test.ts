/**
 * The Runners view of a team turn (docs/agent-ui.md, "What a member's agent
 * sees, and where it goes"): GET /api/runners/:id shows a team_turn run's output with
 * no reply text, a run recorded before the text-free result (whose output carried
 * `reply` and the rows' `text`) and a run of now (ids and status only)
 * alike. Another runner's output is shown as it was. No DBOS: the client
 * and the caller are stood in.
 */
import { describe, expect, it, vi } from 'vitest';

const PRIVATE = 'your private note says the code is 4417';

const h = vi.hoisted(() => ({
  runs: new Map<string, { workflowName: string; input: unknown; output: unknown }>(),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: () => ({ ownerId: 'owner-1' }),
}));

vi.mock('@/lib/dbos-client', () => ({
  getDbosClient: async () => ({
    listWorkflows: async (q: { workflowIDs: string[] }) => {
      const r = h.runs.get(q.workflowIDs[0]!);
      return r
        ? [
            {
              workflowID: q.workflowIDs[0],
              workflowName: r.workflowName,
              status: 'SUCCESS',
              queueName: 'mantle.member',
              createdAt: 1,
              input: r.input,
              output: r.output,
            },
          ]
        : [];
    },
    listWorkflowSteps: async () => [],
  }),
}));

const { GET } = await import('./route');

async function shown(id: string): Promise<{ input?: string; output?: string }> {
  const res = await GET(new Request(`http://brain.invalid/api/runners/${id}`), {
    params: Promise.resolve({ id }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { run: { input?: string; output?: string } }).run;
}

const row = { id: 'o1', model: 'm', traceId: 't1', createdAt: '2026-11-06T00:00:00.000Z' };

describe('Runners: a used_private team turn shows no reply text', () => {
  it("a run recorded before the text-free result: reply and the rows' text dropped, ids kept", async () => {
    h.runs.set('ws-a.k1', {
      workflowName: 'teamTurnWorkflow',
      input: { ownerId: 'owner-1', text: 'what does my note say?', options: {} },
      output: {
        inbound: { id: 'i1', text: 'what does my note say?', createdAt: row.createdAt },
        outbound: { ...row, text: PRIVATE },
        reply: PRIVATE,
      },
    });
    const run = await shown('ws-a.k1');
    expect(run.output).not.toContain(PRIVATE);
    expect(run.output).not.toContain('"reply"');
    expect(run.output).not.toContain('"text"');
    expect(JSON.parse(run.output!)).toEqual({
      inbound: { id: 'i1', createdAt: row.createdAt },
      outbound: row,
    });
  });

  it('a run of now (ids and status only, workflows/team-turn-result.ts) is shown as it is', async () => {
    const result = {
      inbound: { id: 'i2', createdAt: row.createdAt },
      outbound: { ...row, id: 'o2', status: 'complete' },
      replyChars: PRIVATE.length,
    };
    h.runs.set('ws-a.k2', { workflowName: 'teamTurnWorkflow', input: {}, output: result });
    const run = await shown('ws-a.k2');
    expect(run.output).not.toContain(PRIVATE);
    expect(JSON.parse(run.output!)).toEqual(result);
  });

  it("another runner's output is shown as it was", async () => {
    h.runs.set('turn-x', {
      workflowName: 'assistantTurnWorkflow',
      input: {},
      output: { reply: 'hello', outbound: { text: 'hello' } },
    });
    expect(JSON.parse((await shown('turn-x')).output!)).toEqual({
      reply: 'hello',
      outbound: { text: 'hello' },
    });
  });
});
