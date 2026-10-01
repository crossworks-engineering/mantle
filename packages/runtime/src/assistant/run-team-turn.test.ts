import { describe, expect, it } from 'vitest';
import {
  assertAgentForRole,
  emptyLoginContext,
  replyUsedPrivate,
  teamThreadToHistory,
} from './run-team-turn';
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

describe('assertAgentForRole (a login chats with its own level only, plan section 8)', () => {
  it('a member takes a team-level agent and nothing else', () => {
    expect(() =>
      assertAgentForRole({ slug: 'team-responder', audience: 'team' }, 'member'),
    ).not.toThrow();
    for (const audience of ['admin', 'client', 'public']) {
      expect(() => assertAgentForRole({ slug: 'a', audience }, 'member')).toThrow(
        /only chat with a team-level agent/,
      );
    }
    // A stand-in with no level counts as admin: fail closed.
    expect(() => assertAgentForRole({ slug: 'x' }, 'member')).toThrow(/admin level/);
  });

  it('a client takes a client-level agent and nothing else', () => {
    expect(() =>
      assertAgentForRole({ slug: 'client-responder', audience: 'client' }, 'client'),
    ).not.toThrow();
    for (const audience of ['admin', 'team', 'public']) {
      expect(() => assertAgentForRole({ slug: 'a', audience }, 'client')).toThrow(
        /only chat with a client-level agent/,
      );
    }
    expect(() => assertAgentForRole({ slug: 'x' }, 'client')).toThrow(/admin level/);
  });
});

describe('emptyLoginContext (a client turn loads no retrieval context)', () => {
  it('carries no fact, hit, relation, digest, note or history', () => {
    const ctx = emptyLoginContext('what is on the schedule?');
    expect(ctx.facts).toEqual([]);
    expect(ctx.contentHits).toEqual([]);
    expect(ctx.chunkHits).toEqual([]);
    expect(ctx.relations).toEqual([]);
    expect(ctx.digests).toEqual([]);
    expect(ctx.personaNotes).toEqual([]);
    expect(ctx.history).toEqual([]);
    expect(ctx.corpusMap.entries).toEqual([]);
    expect(ctx.journalRelevant).toBe('');
  });
});

describe('replyUsedPrivate (audit S3)', () => {
  it('marks a reply whose turn read the member’s private items', () => {
    expect(replyUsedPrivate([{ slug: 'page_get' }, { slug: 'my_item_open' }], [])).toBe(true);
    expect(replyUsedPrivate([{ slug: 'my_items_list' }], [])).toBe(true);
    expect(replyUsedPrivate([{ slug: 'page_get' }], [])).toBe(false);
  });

  it('keeps marking while a private reply is in the history the model saw', () => {
    expect(replyUsedPrivate([], [{ usedPrivate: false }, { usedPrivate: true }])).toBe(true);
    expect(replyUsedPrivate([], [{ usedPrivate: false }, {}])).toBe(false);
  });
});
