/**
 * A team turn run's result holds ids and status only (docs/agent-ui.md,
 * "What a member's agent sees, and where it goes"): the Runners screen shows it to every
 * Admin user, so a used_private reply's text never lands there.
 */
import { describe, expect, it } from 'vitest';
import { teamTurnResultOf } from './team-turn-result';

const PRIVATE = 'your private note says the code is 4417';

describe('teamTurnResultOf', () => {
  it('keeps the ids, the status and the length, never the text', () => {
    const at = new Date('2026-11-06T00:00:00.000Z');
    const result = teamTurnResultOf({
      inbound: { id: 'i2', createdAt: at },
      outbound: { id: 'o2', status: 'complete', model: 'm', traceId: 't1', createdAt: at },
      reply: PRIVATE,
      ...{ text: PRIVATE },
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(result).toEqual({
      inbound: { id: 'i2', createdAt: at.toISOString() },
      outbound: {
        id: 'o2',
        status: 'complete',
        model: 'm',
        traceId: 't1',
        createdAt: at.toISOString(),
      },
      replyChars: PRIVATE.length,
    });
  });
});
