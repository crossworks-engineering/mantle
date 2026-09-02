import { describe, expect, it } from 'vitest';
import { teamThreadToHistory } from './run-team-turn';
import { isTeamPrivateReadsEnabled, TEAM_PRIVATE_READ_SLUGS } from '@mantle/content';
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

describe('private-reads switch', () => {
  it('defaults OFF (only an explicit true enables private corpus reads)', () => {
    expect(isTeamPrivateReadsEnabled({})).toBe(false);
    expect(isTeamPrivateReadsEnabled({ teamPrivateReads: undefined })).toBe(false);
    expect(isTeamPrivateReadsEnabled({ teamPrivateReads: false })).toBe(false);
    expect(isTeamPrivateReadsEnabled({ teamPrivateReads: true })).toBe(true);
  });

  it('gates exactly email + journal reads (not brain-knowledge reads)', () => {
    const gated = new Set(TEAM_PRIVATE_READ_SLUGS);
    expect(gated.has('email_get')).toBe(true);
    expect(gated.has('email_list')).toBe(true);
    expect(gated.has('journal_get')).toBe(true);
    expect(gated.has('journal_list')).toBe(true);
    // Brain-knowledge + the write tool are NOT gated.
    for (const keep of [
      'search_chunks',
      'file_read',
      'page_get',
      'table_query',
      'team_request_create',
    ]) {
      expect(gated.has(keep)).toBe(false);
    }
  });

  it('strips only the gated slugs when the switch is off', () => {
    const resolved = [
      'search_chunks',
      'file_read',
      'email_get',
      'journal_list',
      'team_request_create',
    ];
    const gated = new Set(TEAM_PRIVATE_READ_SLUGS);
    const off = resolved.filter((s) => !gated.has(s));
    expect(off).toEqual(['search_chunks', 'file_read', 'team_request_create']);
    // On → unchanged.
    const on = isTeamPrivateReadsEnabled({ teamPrivateReads: true })
      ? resolved
      : resolved.filter((s) => !gated.has(s));
    expect(on).toEqual(resolved);
  });
});
