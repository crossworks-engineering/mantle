/**
 * Team Forum store — shared topic threads, the successor to the per-contact
 * Team Chat forever-thread. Topics are titled multi-author threads every
 * member can read (visibility 'team'); 'private' topics are author + owner
 * only. Writers are the forum API routes (member/owner posts), the forum turn
 * pipeline (agent posts, durable-pending like team_messages), and — Phase 2 —
 * the review loop delivering owner resolutions back into their topic.
 *
 * Author identity is snapshotted (`author_name`) and `contact_id` goes SET
 * NULL on contact deletion: forum content is team knowledge and outlives its
 * author, deliberately unlike team_messages. Member names are resolved HERE
 * from the contact node — callers never supply a member display name.

/**
 * Split out of the 995-line forum.ts on 2026-09-02 (audit, tier 3) into
 * forum/{shared,topics,posts,read,members}.ts. The dependency order is
 * one-way — shared <- {topics, posts, read} , members standalone — so no seam
 * imports this barrel.
 *
 * Curated, not `export *`: the split forced `visibleTopicCond`,
 * `topicSearchCond`, `memberName` and `readerIdOf` to become cross-module
 * exports, and none of them is API. The list below is UNCHANGED from the
 * single file it replaces; `forum-exports.test.ts` pins it.
 */

export type {
  ForumTopicListItem,
  ForumMemberActivity,
  ForumMemberPost,
  ForumAuthoredTopic,
} from '@mantle/client-types';

// Re-exported so existing importers keep resolving these from
// '@mantle/content'; the definitions live in forum-visibility.ts, next to the
// predicates that are the single source of truth for the rule.
export type { ForumViewer, ForumAuthor } from '../forum-visibility';

export {
  createForumTopic,
  markForumTopicRead,
  setForumTopicPinned,
  setForumTopicStatus,
  type CreateForumTopicInput,
} from './topics';

export {
  appendForumPost,
  acquireForumAgentPending,
  getForumPost,
  finalizeForumPost,
  sweepStaleForumAgentPosts,
  type AppendForumPostInput,
  type AcquireForumAgentPendingInput,
  type FinalizeForumPostInput,
} from './posts';

export {
  forumTopicsWithAttachedNode,
  FORUM_TOPIC_SORTS,
  listForumTopics,
  countForumTopics,
  getForumTopic,
  listForumPosts,
  searchForumPosts,
  recentForumPosts,
  countForumMemberPostsSince,
  type ForumTopicSort,
  type ForumPostMatch,
} from './read';

export {
  listForumMemberActivity,
  listForumPostsByContact,
  countForumPostsByContact,
  listForumTopicsByAuthor,
} from './members';
