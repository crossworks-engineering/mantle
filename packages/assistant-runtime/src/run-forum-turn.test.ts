import { describe, expect, it } from 'vitest';
import { forumPostsToHistory } from './run-forum-turn';
import type { ForumPost } from '@mantle/db';

/**
 * Prompt-history mapping for forum turns. The invariants:
 *   - only COMPLETE posts with text reach the prompt (the empty pending bubble
 *     and failed turns never leak into a later turn's context);
 *   - human posts (member/owner) become NAME-PREFIXED user turns, the owner
 *     tagged as such, agent posts become assistant turns;
 *   - CONSECUTIVE user turns coalesce into one (strict-alternation providers
 *     reject back-to-back user messages — a forum thread produces them
 *     whenever two humans post without an agent reply between).
 * The bigger isolation invariant (no persona notes / digests / owner history)
 * is structural — runForumTurn passes literal empty arrays to
 * buildChatMessages and loads history ONLY through this mapper.
 */

function post(partial: Partial<ForumPost>): ForumPost {
  return {
    id: 'id',
    ownerId: 'o',
    topicId: 't',
    authorKind: 'member',
    contactId: 'c',
    authorName: 'Sam',
    agentId: null,
    model: null,
    traceId: null,
    body: 'hello',
    attachments: [],
    kind: null,
    sourceRequestTaskId: null,
    channel: 'web',
    status: 'complete',
    error: null,
    createdAt: new Date(),
    editedAt: null,
    ...partial,
  } as ForumPost;
}

describe('forumPostsToHistory', () => {
  it('maps author kinds to roles with name prefixes on human posts', () => {
    const h = forumPostsToHistory([
      post({ authorKind: 'member', authorName: 'Sam', body: 'question' }),
      post({ authorKind: 'agent', authorName: 'Team Responder', body: 'answer' }),
      post({ authorKind: 'owner', authorName: 'Jason', body: 'ruling' }),
    ]);
    expect(h).toEqual([
      { role: 'user', text: 'Sam: question' },
      { role: 'assistant', text: 'answer' },
      { role: 'user', text: 'Jason (brain owner): ruling' },
    ]);
  });

  it('coalesces consecutive human posts into ONE user turn', () => {
    const h = forumPostsToHistory([
      post({ authorName: 'Sam', body: 'first' }),
      post({ authorName: 'Rea', body: 'second' }),
      post({ authorKind: 'agent', body: 'reply' }),
      post({ authorName: 'Sam', body: 'third' }),
    ]);
    expect(h).toEqual([
      { role: 'user', text: 'Sam: first\n\nRea: second' },
      { role: 'assistant', text: 'reply' },
      { role: 'user', text: 'Sam: third' },
    ]);
    // Structural guarantee: never two user turns in a row.
    for (let i = 1; i < h.length; i++) {
      expect(h[i - 1]!.role === 'user' && h[i]!.role === 'user').toBe(false);
    }
  });

  it('drops pending bubbles, failed turns, and empty text', () => {
    const h = forumPostsToHistory([
      post({ authorKind: 'agent', status: 'pending', body: '' }),
      post({ authorKind: 'agent', status: 'failed', body: 'partial' }),
      post({ body: '   ' }),
      post({ authorName: 'Sam', body: 'kept' }),
    ]);
    expect(h).toEqual([{ role: 'user', text: 'Sam: kept' }]);
  });

  it('never merges across an agent reply (order is preserved)', () => {
    const h = forumPostsToHistory([
      post({ authorName: 'Sam', body: 'q1' }),
      post({ authorKind: 'agent', body: 'a1' }),
      post({ authorName: 'Rea', body: 'q2' }),
      post({ authorKind: 'agent', body: 'a2' }),
    ]);
    expect(h.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});
