import { describe, expect, it } from 'vitest';
import { replyUsedPrivate, teamThreadToHistory } from './run-team-turn';
import { isTeamPrivateReadsEnabled, TEAM_PRIVATE_READ_SLUGS } from '@mantle/content';
import type { ThreadMessage } from '@mantle/content';

/**
 * Prompt-history mapping for workspace turns. The invariants:
 *   - only COMPLETE rows with text reach the prompt (the empty pending bubble,
 *     failed turns and a superseded pair never leak into a later turn's
 *     context);
 *   - direction maps inbound→user / outbound→assistant.
 * The bigger isolation invariant (no persona notes, no owner history, no
 * other login's turns) is structural: runTeamTurn loads history ONLY from
 * the login's own thread (0269) through this mapper.
 */

function row(partial: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'id',
    ownerId: 'o',
    direction: 'inbound',
    text: 'hello',
    agentId: 'a',
    model: null,
    channel: 'web',
    attachments: [],
    data: {},
    status: 'complete',
    error: null,
    createdAt: new Date(),
    loginId: 'l',
    workspaceId: null,
    traceId: null,
    usedPrivate: false,
    ...partial,
  } as ThreadMessage;
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
      row({ text: 'superseded', data: { superseded_by: 'x' } }),
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

describe('replyUsedPrivate (audit S3)', () => {
  it('marks no reply by its tools since the my-space tools went (W6b)', () => {
    expect(replyUsedPrivate([{ slug: 'page_get' }, { slug: 'my_item_open' }], [])).toBe(false);
    expect(replyUsedPrivate([{ slug: 'page_get' }], [])).toBe(false);
  });

  it('keeps marking while a private reply is in the history the model saw', () => {
    expect(replyUsedPrivate([], [{ usedPrivate: false }, { usedPrivate: true }])).toBe(true);
    expect(replyUsedPrivate([], [{ usedPrivate: false }, {}])).toBe(false);
  });
});
