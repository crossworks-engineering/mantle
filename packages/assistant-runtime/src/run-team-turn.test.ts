import { describe, expect, it } from 'vitest';
import { teamThreadToHistory } from './run-team-turn';
import type { TeamMessage } from '@mantle/db';

/**
 * Prompt-history mapping for team turns. The invariants:
 *   - only COMPLETE rows with text reach the prompt (the empty pending bubble
 *     and failed turns never leak into a later turn's context);
 *   - direction maps inbound→user / outbound→assistant.
 * The bigger isolation invariant (no persona notes / digests / owner history)
 * is structural — runTeamTurn passes literal empty arrays to
 * buildChatMessages and loads history ONLY through this mapper.
 */

function row(partial: Partial<TeamMessage>): TeamMessage {
  return {
    id: 'id',
    ownerId: 'o',
    contactId: 'c',
    direction: 'inbound',
    text: 'hello',
    agentId: null,
    model: null,
    channel: 'web',
    attachments: [],
    traceId: null,
    status: 'complete',
    error: null,
    createdAt: new Date(),
    ...partial,
  } as TeamMessage;
}

describe('teamThreadToHistory', () => {
  it('maps directions to roles', () => {
    const h = teamThreadToHistory([
      row({ direction: 'inbound', text: 'question' }),
      row({ direction: 'outbound', text: 'answer' }),
    ]);
    expect(h).toEqual([
      { role: 'user', text: 'question' },
      { role: 'assistant', text: 'answer' },
    ]);
  });

  it('drops pending bubbles, failed turns, and empty text', () => {
    const h = teamThreadToHistory([
      row({ status: 'pending', text: '' }),
      row({ status: 'failed', text: 'partial', direction: 'outbound' }),
      row({ text: '   ' }),
      row({ text: 'kept' }),
    ]);
    expect(h).toEqual([{ role: 'user', text: 'kept' }]);
  });
});
