/**
 * The stage poll's delegation-follow (44c718c9). The streaming trail has
 * followed a delegated child since v0.79 (inherited turnId); this poll is the
 * STREAMING-OFF fallback and used to read only the responder trace — whose
 * newest step stays `tool: invoke_agent` for the child's entire run, so the
 * label froze on "Delegating to pages…" for 400+ seconds.
 *
 * What must hold:
 *   - while invoke_agent is RUNNING and a running child trace exists, the poll
 *     surfaces the CHILD's newest step, attributed by agent name;
 *   - every miss falls back to the parent's own label rather than blanking:
 *     the child row not inserted yet, or the child holding no labelable step;
 *   - a FINISHED invoke_agent step never follows — the child is done, and the
 *     parent's next activity (or its own label) is the truth.
 *
 * The db is mocked as a queue of select results in call order — the queries
 * are all single-row `.limit(1)` reads, so the shape is stable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ results: [] as unknown[][] }));

vi.mock('@mantle/db', async () => {
  // Partial mock: the real module's schema objects must survive — modules in
  // the transitive import graph (e.g. @mantle/content) read column refs from
  // them at load time. Only the `db` handle is replaced.
  const actual = await vi.importActual<typeof import('@mantle/db')>('@mantle/db');
  const chain = () => {
    const p = {
      from: () => p,
      leftJoin: () => p,
      where: () => p,
      orderBy: () => p,
      limit: () => Promise.resolve(h.results.shift() ?? []),
    };
    return p;
  };
  return { ...actual, db: { select: () => chain() } };
});

import { currentTurnStageLabel } from './turn-stage';

const RESPONDER_TRACE = [{ id: 'trace-parent' }];
const RUNNING_INVOKE = [
  { name: 'tool: invoke_agent', status: 'running', input: { args: { agent: 'pages' } } },
];

beforeEach(() => {
  h.results.length = 0;
});

describe('currentTurnStageLabel — delegation follow', () => {
  it("surfaces the running child's current step, attributed by agent name", async () => {
    h.results.push(
      RESPONDER_TRACE,
      RUNNING_INVOKE,
      [{ id: 'trace-child', agentName: 'Pages' }],
      [{ name: 'tool: page_block_update', input: {} }],
    );

    expect(await currentTurnStageLabel('o1')).toBe('Pages · Updating that…');
  });

  it('falls back to "Delegating to …" while the child trace is not inserted yet', async () => {
    h.results.push(RESPONDER_TRACE, RUNNING_INVOKE, [] /* no running child */);

    expect(await currentTurnStageLabel('o1')).toBe('Delegating to pages…');
  });

  it('falls back when the child has no labelable step yet', async () => {
    h.results.push(
      RESPONDER_TRACE,
      RUNNING_INVOKE,
      [{ id: 'trace-child', agentName: 'Pages' }],
      [] /* no steps yet */,
    );

    expect(await currentTurnStageLabel('o1')).toBe('Delegating to pages…');
  });

  it('never follows a FINISHED invoke_agent step — the parent has moved on', async () => {
    h.results.push(RESPONDER_TRACE, [
      { name: 'tool: invoke_agent', status: 'success', input: { args: { agent: 'pages' } } },
    ]);

    // Only two queries run — the child lookup must not fire at all.
    expect(await currentTurnStageLabel('o1')).toBe('Delegating to pages…');
    expect(h.results.length).toBe(0);
  });

  it("labels the child's thinking rounds too, so a long LLM call isn't a dead trail", async () => {
    h.results.push(
      RESPONDER_TRACE,
      RUNNING_INVOKE,
      [{ id: 'trace-child', agentName: 'Pages' }],
      [{ name: 'anthropic_chat[2]', input: {} }],
    );

    expect(await currentTurnStageLabel('o1')).toBe('Pages · Thinking…');
  });
});
