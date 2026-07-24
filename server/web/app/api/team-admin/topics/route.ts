/**
 * GET /api/team-admin/topics?topic=<id>&q=&page=<n> — the Topics tab's data:
 * the owner-view topic list (paged, searchable) + the selected topic's
 * transcript and upload review states. Mirrors the old SSR page, including
 * the deep-link rule: a ?topic= not on this page (e.g. from the uploads
 * queue) is fetched directly instead of silently selecting an unrelated one.
 *
 * Read-only — the mark-as-read render side effect moved to an explicit
 * POST /api/team-admin/forum/topics/[id]/read.
 */
import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import {
  listForumTopics,
  countForumTopics,
  getForumTopic,
  listForumPosts,
  listForumUploadStatesForTopic,
  type ForumTopicListItem,
} from '@mantle/content';
import { teamAdminBadges } from '@/lib/team-admin-overview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOPICS_PAGE_SIZE = 30;

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const topicParam = url.searchParams.get('topic') ?? undefined;
  const query = url.searchParams.get('q')?.trim() || undefined;
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

  const [badges, topics, topicTotal] = await Promise.all([
    teamAdminBadges(user.id),
    listForumTopics(
      user.id,
      { kind: 'owner' },
      { query, limit: TOPICS_PAGE_SIZE, offset: (page - 1) * TOPICS_PAGE_SIZE },
    ),
    countForumTopics(user.id, { kind: 'owner' }, { query }),
  ]);

  type SelectedTopic = {
    id: string;
    title: string;
    kind: ForumTopicListItem['kind'];
    visibility: ForumTopicListItem['visibility'];
    pinned: boolean;
    status: ForumTopicListItem['status'];
    authorName: string;
    createdAt: string;
  };
  let selectedTopic: SelectedTopic | null =
    topics.find((t) => t.id === topicParam) ?? topics[0] ?? null;
  if (topicParam && !topics.some((t) => t.id === topicParam)) {
    const t = await getForumTopic(user.id, topicParam, { kind: 'owner' });
    selectedTopic = t ? { ...t, createdAt: t.createdAt.toISOString() } : null;
  }

  const selectedTopicId = selectedTopic?.id ?? null;
  const [posts, uploadStates] = selectedTopicId
    ? await Promise.all([
        listForumPosts(user.id, selectedTopicId, { limit: 100 }),
        listForumUploadStatesForTopic(user.id, selectedTopicId),
      ])
    : [[], []];

  return NextResponse.json({
    badges,
    topics,
    topicTotal,
    page,
    pageSize: TOPICS_PAGE_SIZE,
    selected: selectedTopic ? { topic: selectedTopic, posts, uploadStates } : null,
  });
}
