import { describe, expect, it } from 'vitest';
import * as forumApi from './forum';

/**
 * Companion to `pages-exports.test.ts`, for the same reason and one weaker.
 * `./forum` is NOT a package sub-path — only the curated `index-team.ts`
 * barrel imports it — so widening it leaks no further than this package.
 *
 * It is still pinned, because the 2026-09-02 split of the 995-line forum.ts
 * into forum/{shared,topics,posts,read,members}.ts forced four internals to
 * become cross-module exports: `visibleTopicCond`, `topicSearchCond`,
 * `memberName` and `readerIdOf`. Three of those are load-bearing security
 * plumbing — the visibility predicate, the search predicate, and the resolver
 * that makes an author name un-forgeable — and a later `export *` would offer
 * all three to any caller that imports the barrel. That is worth a test.
 *
 * Runtime values only: `import *` cannot see type-only exports. The eleven
 * exported types are pinned by the compiler instead, via index-team.ts.
 */
const PUBLIC_VALUE_EXPORTS = [
  'FORUM_TOPIC_SORTS',
  'acquireForumAgentPending',
  'appendForumPost',
  'countForumMemberPostsSince',
  'countForumPostsByContact',
  'countForumTopics',
  'createForumTopic',
  'finalizeForumPost',
  'forumTopicsWithAttachedNode',
  'getForumPost',
  'getForumTopic',
  'listForumMemberActivity',
  'listForumPosts',
  'listForumPostsByContact',
  'listForumTopics',
  'listForumTopicsByAuthor',
  'markForumTopicRead',
  'recentForumPosts',
  'searchForumPosts',
  'setForumTopicPinned',
  'setForumTopicStatus',
  'sweepStaleForumAgentPosts',
];

/** Helpers the split made cross-module. None of them is API. */
const MUST_STAY_INTERNAL = ['visibleTopicCond', 'topicSearchCond', 'memberName', 'readerIdOf'];

describe('@mantle/content forum surface', () => {
  it('exports exactly the pinned list', () => {
    expect(Object.keys(forumApi).sort()).toEqual([...PUBLIC_VALUE_EXPORTS].sort());
  });

  it('does not leak the split helpers', () => {
    for (const name of MUST_STAY_INTERNAL) {
      expect(Object.keys(forumApi)).not.toContain(name);
    }
  });
});
