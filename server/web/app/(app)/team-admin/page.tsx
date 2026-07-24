import Link from 'next/link';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import {
  listApps,
  listTeamMemberActivity,
  listTeamThread,
  listTeamAccess,
  listTeamRequests,
  markTeamThreadRead,
  loadProfilePreferences,
  isTeamPrivateReadsEnabled,
  listActiveShares,
  listTeamShareTags,
  listForumTopics,
  countForumTopics,
  listForumPosts,
  getForumTopic,
  markForumTopicRead,
  listForumUploadStatesForTopic,
  listPendingForumUploads,
  countPendingForumUploads,
  listForumMemberActivity,
  listForumPostsByContact,
  countForumPostsByContact,
  listForumTopicsByAuthor,
  formatAttachmentSize,
  type TeamMemberActivity,
  type TeamRequest,
  type ForumTopicListItem,
  type PendingForumUpload,
  type ForumMemberActivity,
  type ForumMemberPost,
  type ForumAuthoredTopic,
} from '@mantle/content';
import { reconcileForumQuarantine } from '@/lib/forum-quarantine';
import { SharedLinksPanel } from '@/components/share/shared-links-panel';
import { HubAppPicker } from '@/components/team-chat/hub-app-picker';
import { DashboardTagsPanel } from '@/components/team-chat/dashboard-tags-panel';
import { PrivateReadsToggle } from '@/components/team-chat/private-reads-toggle';
import { RequestReply } from '@/components/team-chat/request-reply';
import { ThreadAccessSplit } from '@/components/team-chat/access-split';
import {
  AdminTopicPager,
  AdminTopicSearch,
  TopicPinToggle,
  TopicReplyForm,
} from '@/components/team-forum/admin-topic-controls';
import { UploadReviewActions } from '@/components/team-forum/admin-upload-controls';
import { KindBadge, TopicFlags } from '@/components/team-forum/forum-meta';
import {
  Archive,
  MessagesSquare,
  ExternalLink,
  Inbox,
  CheckCircle2,
  Paperclip,
  Users,
} from 'lucide-react';
import { MemberActivityPager } from '@/components/team-admin/member-activity-pager';
import { cn } from '@mantle/web-ui/lib/utils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * /team-admin — the owner's window into the external team surface
 * (decision: a dedicated route, room to grow into the team-platform hub).
 *
 * Tabs: Members · Topics · Requests · Shared links · Settings.
 *
 * **Members** is the person-first view. It used to be "Chats" — a preview of
 * each member's 1:1 Team Chat thread — but the Forum replaced that surface
 * (the write path now 410s; see app/api/team/turn/route.ts), so on any brain
 * provisioned after the Forum shipped that pane was permanently empty. The
 * detail pane now shows what a member ACTUALLY does: their forum posts with
 * the agent answer each one drew, the topics they started, the requests they
 * filed, and their access log. Members carrying a pre-Forum transcript keep it
 * as a collapsed "Chat archive" — history is never hidden, just demoted.
 *
 * Token mint/rotate/revoke stays on the contact's page (linked) — one
 * lifecycle surface, not two. Surface-wide switches (private reads, hub app,
 * curated tags) live on Settings; they are not member-scoped and used to sit
 * confusingly above the member list.
 *
 * Server-rendered + URL-driven (?contact=<id>), matching the list-screen
 * conventions; every pane is a read-only preview, not a live chat.
 */
export const dynamic = 'force-dynamic';

function fmtWhen(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A member row: roster + token facts from the team-token store, activity
 *  numbers from the forum. `forum` is null for a member who has never posted —
 *  the aggregate query only returns contacts with posts. */
type MemberRow = TeamMemberActivity & { forum: ForumMemberActivity | null };

function MemberList({ members, selectedId }: { members: MemberRow[]; selectedId: string | null }) {
  if (members.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No team members yet. Enable a contact as a team member from their page in{' '}
        <Link href="/contacts" className="underline">
          Contacts
        </Link>{' '}
        — their token is what unlocks <code>/team</code>.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1 p-2">
      {members.map((m) => (
        <li key={m.contactId}>
          <Link
            href={`/team-admin?contact=${m.contactId}`}
            className={cn(
              // Selection = left accent bar only (the repo's list idiom) — a
              // bg-accent fill is unreadable in saturated-accent themes.
              'block rounded-md border border-l-[3px] border-border border-l-border px-3 py-2 transition-colors hover:bg-muted/50',
              m.contactId === selectedId && 'border-l-primary bg-muted/40',
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium">{m.contactName}</span>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                {/* Unread = their forum posts the owner hasn't read in the
                    topic. Clears by opening the TOPIC, not this row. */}
                {(m.forum?.unread ?? 0) > 0 ? (
                  <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                    {m.forum?.unread}
                  </span>
                ) : null}
                {fmtWhen(m.forum?.lastPostAt ?? null)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {m.forum?.lastPostBody
                ? `${m.forum.lastPostTopicTitle ? `${m.forum.lastPostTopicTitle} — ` : ''}${m.forum.lastPostBody}`
                : `member since ${fmtWhen(m.memberSince)} — no posts yet`}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function TeamTabs({
  active,
  openRequestCount,
}: {
  active: 'members' | 'topics' | 'requests' | 'shares' | 'settings';
  openRequestCount: number;
}) {
  const tab = (label: string, href: string, isActive: boolean, badge?: number) => (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors',
        isActive
          ? 'border-primary font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      {badge ? (
        <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
          {badge}
        </span>
      ) : null}
    </Link>
  );
  return (
    <div className="flex items-center gap-1 border-b border-border px-3">
      {tab('Members', '/team-admin', active === 'members')}
      {tab('Topics', '/team-admin?view=topics', active === 'topics')}
      {tab('Requests', '/team-admin?view=requests', active === 'requests', openRequestCount)}
      {tab('Shared links', '/team-admin?view=shares', active === 'shares')}
      {tab('Settings', '/team-admin?view=settings', active === 'settings')}
    </div>
  );
}

/** Pending forum uploads grouped by topic — the review queue's file half.
 *  Approving ("Move to files") is the ONLY path from quarantine into the
 *  brain; a topic title links to its thread for context. Every pending upload
 *  is bound to a topic (binding sets topic_id + status together), so there is
 *  no untitled/staged branch here. */
function UploadsSection({
  uploads,
  moreUploads,
}: {
  uploads: PendingForumUpload[];
  moreUploads: number;
}) {
  if (uploads.length === 0) return null;
  const groups = new Map<string, PendingForumUpload[]>();
  for (const u of uploads) {
    const key = u.topicId ?? 'unbound';
    const list = groups.get(key);
    if (list) list.push(u);
    else groups.set(key, [u]);
  }
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <Paperclip className="size-4" aria-hidden />
        Uploads awaiting review
        <span className="text-xs font-normal text-muted-foreground">
          — files stay out of the brain until you move them to files/review
        </span>
      </h2>
      {moreUploads > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing the {uploads.length} longest-waiting — {moreUploads} more appear as you clear
          these.
        </p>
      )}
      {[...groups.entries()].map(([topicId, blobs]) => (
        <div key={topicId} className="rounded-lg border border-border bg-card text-card-foreground">
          <div className="border-b border-border/60 px-4 py-2">
            <Link
              href={`/team-admin?view=topics&topic=${topicId}`}
              className="text-sm font-medium underline-offset-2 hover:underline"
            >
              {blobs[0]?.topicTitle ?? 'Untitled topic'} →
            </Link>
          </div>
          <ul className="divide-y divide-border/60">
            {blobs.map((u) => (
              <li
                key={u.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {u.filename}
                    <span className="text-muted-foreground">
                      {' '}
                      ({formatAttachmentSize(u.sizeBytes)})
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    from {u.contactName ?? 'a team member'} ·{' '}
                    {new Date(u.createdAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <UploadReviewActions uploadId={u.id} filename={u.filename} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function RequestsPanel({
  requests,
  uploads,
  moreUploads,
}: {
  requests: TeamRequest[];
  uploads: PendingForumUpload[];
  moreUploads: number;
}) {
  if (requests.length === 0 && uploads.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center text-sm text-muted-foreground">
          <Inbox className="mx-auto mb-2 size-6" />
          <p>No change requests or uploads yet. When a team member asks for content to be</p>
          <p>updated or attaches a file, it lands here for a specialist to review.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        <UploadsSection uploads={uploads} moreUploads={moreUploads} />
        {requests.map((r) => (
          <div
            key={r.taskId}
            className={cn(
              'rounded-lg border border-border bg-card p-4 text-card-foreground',
              r.status === 'done' && 'opacity-70',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">{r.title}</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  from {r.contactName ?? 'a team member'} ·{' '}
                  {new Date(r.createdAt).toLocaleDateString()}
                  {r.notifiedAt ? ' · replied' : ''}
                </p>
              </div>
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs',
                  r.status === 'done'
                    ? 'bg-muted text-muted-foreground'
                    : 'bg-primary/10 text-primary',
                )}
              >
                {r.status === 'done' ? <CheckCircle2 className="size-3" /> : null}
                {r.status === 'done' ? 'done' : 'open'}
              </span>
            </div>
            {r.body ? (
              <div className="prose prose-accent prose-sm mt-2 max-w-none dark:prose-invert">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{r.body}</ReactMarkdown>
              </div>
            ) : null}
            <div className="mt-2 flex gap-3 text-xs">
              <Link
                href={`/tasks?selected=${r.taskId}`}
                className="text-muted-foreground underline-offset-2 hover:underline"
              >
                Open task →
              </Link>
              {r.contactId ? (
                <Link
                  href={`/team-admin?contact=${r.contactId}`}
                  className="text-muted-foreground underline-offset-2 hover:underline"
                >
                  View their chat →
                </Link>
              ) : null}
            </div>
            {r.contactId ? (
              <RequestReply
                taskId={r.taskId}
                contactName={r.contactName}
                done={r.status === 'done'}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function TopicList({
  topics,
  selectedId,
  query,
  page,
}: {
  topics: ForumTopicListItem[];
  selectedId: string | null;
  query?: string;
  page: number;
}) {
  const ctx =
    `${query ? `&q=${encodeURIComponent(query)}` : ''}` + `${page > 1 ? `&page=${page}` : ''}`;
  if (topics.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {query
          ? `No topics or posts match “${query}”.`
          : 'No forum topics yet. Members start them at /team/forum — pinned topics float to the top of everyone’s list.'}
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1 p-2">
      {topics.map((t) => (
        <li key={t.id}>
          <Link
            href={`/team-admin?view=topics&topic=${t.id}${ctx}`}
            className={cn(
              'block rounded-md border border-l-[3px] border-border border-l-border px-3 py-2 transition-colors hover:bg-muted/50',
              t.id === selectedId && 'border-l-primary bg-muted/40',
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                {t.unread > 0 ? (
                  <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden />
                ) : null}
                <span className="truncate text-sm font-medium">{t.title}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {fmtWhen(t.lastPostAt)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <TopicFlags pinned={t.pinned} visibility={t.visibility} status={t.status} />
              <KindBadge kind={t.kind} />
              <span className="min-w-0 truncate">
                {t.authorName} · {t.postCount} {t.postCount === 1 ? 'post' : 'posts'}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** One member post paired with the answer it drew — the atom of the activity
 *  feed, and the direct successor to a chat question/answer pair. The topic
 *  title is the link out: everything else about the thread (other authors,
 *  pin, reply box) lives on the Topics tab, not here. */
function ActivityPost({ post }: { post: ForumMemberPost }) {
  return (
    <li className="rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2 text-xs">
        <Link
          href={`/team-admin?view=topics&topic=${post.topicId}`}
          className="min-w-0 truncate font-medium underline-offset-2 hover:underline"
        >
          {post.topicTitle}
        </Link>
        <TopicFlags pinned={false} visibility={post.topicVisibility} status={post.topicStatus} />
        {post.kind ? <KindBadge kind={post.kind} /> : null}
        <span className="ml-auto shrink-0 text-muted-foreground">{fmtWhen(post.createdAt)}</span>
      </div>
      <div className="px-3 py-2">
        <p className="whitespace-pre-wrap text-sm">{post.body}</p>
        {post.attachments.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {post.attachments.map((a, i) => (
              <span
                key={a.fileId ?? `${post.id}-${i}`}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
              >
                <Paperclip className="size-3" aria-hidden />
                {a.caption ?? 'attachment'}
              </span>
            ))}
          </div>
        )}
      </div>
      {/* The answer. Absent when the poster waved the agent off ("no answer
          needed", the default in discussion topics) or the turn is still owed
          — say which, rather than rendering nothing and looking broken. */}
      <div className="border-t border-border/60 bg-muted/30 px-3 py-2">
        {post.reply === null ? (
          <p className="text-xs italic text-muted-foreground">No assistant answer to this post.</p>
        ) : post.reply.status === 'pending' ? (
          <p className="text-xs italic text-muted-foreground">answering…</p>
        ) : post.reply.status === 'failed' ? (
          <p className="text-xs text-destructive">
            Turn failed: {post.reply.error ?? 'unknown error'}
          </p>
        ) : (
          <>
            <div className="mb-1 flex items-baseline gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{post.reply.authorName}</span>
              <span>{fmtWhen(post.reply.createdAt)}</span>
              {post.reply.traceId ? (
                <Link
                  href={`/traces/${post.reply.traceId}`}
                  className="ml-auto inline-flex items-center gap-1 underline-offset-2 hover:underline"
                >
                  <ExternalLink className="size-3" /> trace
                </Link>
              ) : null}
            </div>
            <div className="prose prose-accent prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{post.reply.body}</ReactMarkdown>
            </div>
          </>
        )}
      </div>
    </li>
  );
}

/** Topics this member started — the "what did they bring to the room" list,
 *  distinct from the posts feed (they also post into others' topics). */
function AuthoredTopics({ topics }: { topics: ForumAuthoredTopic[] }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Topics started
      </h3>
      <ul className="divide-y divide-border/60 rounded-lg border border-border bg-card text-card-foreground">
        {topics.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Link
              href={`/team-admin?view=topics&topic=${t.id}`}
              className="min-w-0 truncate text-sm underline-offset-2 hover:underline"
            >
              {t.title}
            </Link>
            <TopicFlags pinned={t.pinned} visibility={t.visibility} status={t.status} />
            <KindBadge kind={t.kind} />
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {t.postCount} {t.postCount === 1 ? 'post' : 'posts'} · {fmtWhen(t.lastPostAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The member's own change requests. The Requests tab is the work queue (with
 *  reply + mark-done); this is the person-scoped mirror, read-only. */
function MemberRequestList({ requests }: { requests: TeamRequest[] }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Requests filed
      </h3>
      <ul className="divide-y divide-border/60 rounded-lg border border-border bg-card text-card-foreground">
        {requests.map((r) => (
          <li key={r.taskId} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Link
              href={`/tasks?selected=${r.taskId}`}
              className="min-w-0 truncate text-sm underline-offset-2 hover:underline"
            >
              {r.title}
            </Link>
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs',
                r.status === 'done'
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-primary/10 text-primary',
              )}
            >
              {r.status === 'done' ? <CheckCircle2 className="size-3" /> : null}
              {r.status === 'done' ? 'done' : 'open'}
            </span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {fmtWhen(r.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The pre-Forum 1:1 transcript, collapsed. Rendered ONLY when the member
 * actually has one — a brain provisioned after the Forum shipped must never
 * see a ghost of a surface it never had. `<details>` (not a Dialog/Collapsible)
 * because this is a static disclosure inside a server component: no client
 * bundle, and it stays open across the page's URL-driven re-renders.
 */
function ChatArchive({
  thread,
  count,
}: {
  thread: Awaited<ReturnType<typeof listTeamThread>>;
  count: number;
}) {
  return (
    <details className="rounded-lg border border-border bg-card text-card-foreground">
      <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground">
        <Archive className="size-3.5" aria-hidden />
        Chat archive ({count} {count === 1 ? 'message' : 'messages'})
        <span className="font-normal">— the 1:1 thread, before the Forum</span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-border/60 px-3 py-3">
        {thread.length < count && (
          <p className="text-center text-xs text-muted-foreground">
            Showing the latest {thread.length} of {count}.
          </p>
        )}
        {thread.map((m) =>
          m.direction === 'inbound' ? (
            <div
              key={m.id}
              className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
            >
              <p className="whitespace-pre-wrap">{m.text}</p>
              <p className="mt-1 text-right text-xs text-primary-foreground/70">
                {fmtWhen(m.createdAt.toISOString())}
              </p>
            </div>
          ) : (
            <div key={m.id} className="mr-auto w-full max-w-[85%] rounded-lg bg-muted/40 px-3 py-2">
              {m.status === 'failed' ? (
                <p className="text-sm text-destructive">
                  Turn failed: {m.error ?? 'unknown error'}
                </p>
              ) : (
                <div className="prose prose-accent prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                </div>
              )}
              <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>{fmtWhen(m.createdAt.toISOString())}</span>
                {m.traceId ? (
                  <Link
                    href={`/traces/${m.traceId}`}
                    className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                  >
                    <ExternalLink className="size-3" /> trace
                  </Link>
                ) : null}
              </div>
            </div>
          ),
        )}
      </div>
    </details>
  );
}

export default async function TeamAdminPage({
  searchParams,
}: {
  searchParams: Promise<{
    contact?: string;
    view?: string;
    topic?: string;
    q?: string;
    page?: string;
    /** Activity-feed page on the Members tab — deliberately not `page`, so the
     *  two tabs' pagers never read each other's cursor. */
    apage?: string;
  }>;
}) {
  const user = await requireOwner();
  const { contact, view, topic: topicParam, q, page, apage } = await searchParams;
  const showRequests = view === 'requests';

  const [roster, forumActivity, prefs, openRequests, apps, pendingUploadCount, sharedPageTags] =
    await Promise.all([
      listTeamMemberActivity(user.id),
      listForumMemberActivity(user.id),
      loadProfilePreferences(user.id),
      listTeamRequests(user.id, { status: 'open' }).then((r) => r.length),
      listApps(user.id, { limit: 200 }),
      countPendingForumUploads(user.id),
      listTeamShareTags(user.id, 'page'),
    ]);
  // Roster (every live token holder) LEFT-joined to forum activity in memory —
  // the aggregate only returns contacts who have posted, so a freshly enabled
  // member still shows, at the bottom. Order: most recent forum post first,
  // then never-posted members by membership date (newest first) so a just-
  // added member is visible without scrolling.
  const forumByContact = new Map(forumActivity.map((f) => [f.contactId, f]));
  const members: MemberRow[] = roster
    .map((m) => ({ ...m, forum: forumByContact.get(m.contactId) ?? null }))
    .sort((a, b) => {
      const aAt = a.forum?.lastPostAt ?? null;
      const bAt = b.forum?.lastPostAt ?? null;
      if (aAt && bAt) return bAt.localeCompare(aAt);
      if (aAt) return -1;
      if (bAt) return 1;
      return b.memberSince.localeCompare(a.memberSince);
    });
  // The Requests badge counts everything awaiting the specialist: open change
  // requests + forum uploads pending review.
  const openRequestCount = openRequests + pendingUploadCount;
  const privateReads = isTeamPrivateReadsEnabled(prefs);
  // Designation candidates: published apps only (the API enforces it too).
  // Include the current designee even if its build went red, LABELLED — the
  // owner must be able to see that members are currently getting the built-in
  // fallback, and clear it.
  const hubCandidates = apps
    .filter((a) => a.hasBuild || a.id === prefs.teamHubAppId)
    .map((a) => ({
      id: a.id,
      title: a.hasBuild ? a.title : `${a.title} (build failed — members see the built-in hub)`,
    }));
  const hubAppId =
    prefs.teamHubAppId && apps.some((a) => a.id === prefs.teamHubAppId) ? prefs.teamHubAppId : null;

  if (view === 'settings') {
    // Surface-wide switches. These used to sit in the member-list sidebar,
    // where they read as per-member chat settings — none of them is: they
    // govern the whole team surface (chat archive, forum, hub, workspace).
    return (
      <div className="flex h-full flex-col">
        <SetPageTitle title="Team" />
        <TeamTabs active="settings" openRequestCount={openRequestCount} />
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
            <div className="rounded-lg border border-border bg-card p-4 text-card-foreground">
              <h2 className="text-sm font-semibold">Read posture</h2>
              <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
                Members always get brain-knowledge reads. This gates your PRIVATE corpus (email and
                journal) for every team surface — the Forum included. Default off.
              </p>
              <PrivateReadsToggle initial={privateReads} />
            </div>

            {/* Keyed by the current designation so a server-side change
                (another tab, MCP) resyncs the Select on refresh. */}
            <div className="rounded-lg border border-border bg-card p-4 text-card-foreground">
              <h2 className="text-sm font-semibold">Hub app</h2>
              <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
                Which published app renders full-bleed at <code>/hub</code> for members. The
                built-in briefing hub is the fallback.
              </p>
              <HubAppPicker
                key={hubAppId ?? 'builtin'}
                currentAppId={hubAppId}
                apps={hubCandidates}
              />
            </div>

            <div className="rounded-lg border border-border bg-card p-4 text-card-foreground">
              <h2 className="text-sm font-semibold">Dashboard sections</h2>
              <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
                Curated tag sections on the <code>/team</code> overview, drawn from your shared
                pages.
              </p>
              <DashboardTagsPanel
                key={(prefs.teamHubTags ?? []).join(',')}
                initialTags={prefs.teamHubTags ?? []}
                available={sharedPageTags}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'shares') {
    const active = await listActiveShares(user.id);
    return (
      <div className="flex h-full flex-col">
        <SetPageTitle title="Team" />
        <TeamTabs active="shares" openRequestCount={openRequestCount} />
        <SharedLinksPanel
          initial={active.map((s) => ({
            id: s.id,
            path: `/s/${s.token}`,
            nodeId: s.nodeId,
            nodeType: s.nodeType,
            title: s.title,
            icon: s.nodeIcon,
            mode: s.mode,
            cascade: s.cascade,
            createdAt: s.createdAt,
            viewCount: s.viewCount,
            lastViewedAt: s.lastViewedAt,
          }))}
        />
      </div>
    );
  }

  if (view === 'topics') {
    const TOPICS_PAGE_SIZE = 30;
    const query = q?.trim() || undefined;
    const pageNum = Math.max(1, Number.parseInt(page ?? '1', 10) || 1);
    const [topics, topicTotal] = await Promise.all([
      listForumTopics(
        user.id,
        { kind: 'owner' },
        {
          query,
          limit: TOPICS_PAGE_SIZE,
          offset: (pageNum - 1) * TOPICS_PAGE_SIZE,
        },
      ),
      countForumTopics(user.id, { kind: 'owner' }, { query }),
    ]);
    // Header fields common to a list row and a directly-fetched topic row.
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
    // Deep link to a topic not on this page (e.g. from the Uploads queue, when
    // the topic has scrolled past page 1) — load it directly instead of
    // silently landing on an unrelated transcript.
    if (topicParam && !topics.some((t) => t.id === topicParam)) {
      const t = await getForumTopic(user.id, topicParam, { kind: 'owner' });
      if (t) selectedTopic = { ...t, createdAt: t.createdAt.toISOString() };
    }
    const selectedTopicId = selectedTopic?.id ?? null;
    const [posts, uploadStateRows] = selectedTopicId
      ? await Promise.all([
          listForumPosts(user.id, selectedTopicId, { limit: 100 }),
          listForumUploadStatesForTopic(user.id, selectedTopicId),
        ])
      : [[], []];
    // Blob review states so admin chips reflect dismissed/filed (join by fileId).
    const uploadStates = new Map(uploadStateRows.map((u) => [u.id, u.status]));
    if (selectedTopicId) {
      await markForumTopicRead(user.id, { kind: 'owner' }, selectedTopicId);
    }
    return (
      <div className="flex h-full flex-col">
        <SetPageTitle title="Team" />
        <TeamTabs active="topics" openRequestCount={openRequestCount} />
        <div className="min-h-0 flex-1 md:grid md:grid-cols-[340px_1fr]">
          <aside className="flex min-h-0 flex-col border-r border-border">
            <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Forum topics</h2>
              <AdminTopicSearch initialQuery={query ?? ''} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              <TopicList
                topics={topics}
                selectedId={selectedTopicId}
                query={query}
                page={pageNum}
              />
            </div>
            <AdminTopicPager page={pageNum} total={topicTotal} pageSize={TOPICS_PAGE_SIZE} />
          </aside>

          <section className="flex min-h-0 flex-col">
            {selectedTopic ? (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold">{selectedTopic.title}</h2>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <TopicFlags
                        pinned={selectedTopic.pinned}
                        visibility={selectedTopic.visibility}
                        status={selectedTopic.status}
                      />
                      <KindBadge kind={selectedTopic.kind} />
                      <span>
                        started by {selectedTopic.authorName} · {fmtWhen(selectedTopic.createdAt)}
                      </span>
                    </p>
                  </div>
                  <TopicPinToggle topicId={selectedTopic.id} pinned={selectedTopic.pinned} />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 py-4">
                  <div className="mx-auto flex max-w-3xl flex-col gap-3">
                    {posts.map((p) => (
                      <div
                        key={p.id}
                        className={cn(
                          'w-full rounded-lg border px-3 py-2',
                          p.authorKind === 'member'
                            ? 'border-primary/20 bg-primary/5'
                            : 'border-border bg-card text-card-foreground',
                        )}
                      >
                        <div className="mb-1 flex items-baseline gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{p.authorName}</span>
                          {p.authorKind !== 'member' && (
                            <span className="rounded-full border border-border px-1.5 py-px text-[10px] uppercase tracking-wider">
                              {p.authorKind === 'agent' ? 'Assistant' : 'Owner'}
                            </span>
                          )}
                          <span>{fmtWhen(p.createdAt.toISOString())}</span>
                          {p.traceId ? (
                            <Link
                              href={`/traces/${p.traceId}`}
                              className="ml-auto inline-flex items-center gap-1 underline-offset-2 hover:underline"
                            >
                              <ExternalLink className="size-3" /> trace
                            </Link>
                          ) : null}
                        </div>
                        {p.status === 'failed' ? (
                          <p className="text-sm text-destructive">
                            Turn failed: {p.error ?? 'unknown error'}
                          </p>
                        ) : p.status === 'pending' ? (
                          <p className="text-sm italic text-muted-foreground">answering…</p>
                        ) : p.authorKind === 'member' ? (
                          <p className="whitespace-pre-wrap text-sm">{p.body}</p>
                        ) : (
                          <div className="prose prose-accent prose-sm max-w-none dark:prose-invert">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.body}</ReactMarkdown>
                          </div>
                        )}
                        {p.attachments.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {p.attachments.map((a) => {
                              if (!a.fileId) return null;
                              const st = uploadStates.get(a.fileId);
                              // Dismissed bytes are gone — render a dead chip, no
                              // link (the download route 404s).
                              if (st === 'dismissed') {
                                return (
                                  <span
                                    key={a.fileId}
                                    className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground line-through"
                                    title="Dismissed — bytes deleted"
                                  >
                                    <Paperclip className="size-3" aria-hidden />
                                    {a.caption ?? 'attachment'}
                                  </span>
                                );
                              }
                              return (
                                <a
                                  key={a.fileId}
                                  href={`/api/team-admin/forum/uploads/${a.fileId}/download`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                                  title={st === 'filed' ? 'Filed into files/review' : undefined}
                                >
                                  <Paperclip className="size-3" aria-hidden />
                                  {a.caption ?? 'attachment'}
                                  {st === 'filed' ? ' ✓' : ''}
                                </a>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="border-t border-border px-4 py-3">
                  <div className="mx-auto max-w-3xl">
                    <TopicReplyForm topicId={selectedTopic.id} status={selectedTopic.status} />
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <div className="text-center text-sm text-muted-foreground">
                  <MessagesSquare className="mx-auto mb-2 size-6" />
                  <p>The team&rsquo;s shared forum threads land here.</p>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    );
  }

  if (showRequests) {
    // Opportunistic quarantine GC while the owner is here — covers brains whose
    // members stopped uploading (the upload route's reconcile never fires then).
    // Awaited (cheap: one guarded DELETE + a dir-scan) so it can't be dropped
    // by the server component ending before a dangling promise resolves.
    await reconcileForumQuarantine(user.id).catch((err) =>
      console.warn('[team-admin] quarantine reconcile failed:', err),
    );
    const UPLOADS_SHOWN = 100;
    const [requests, uploads] = await Promise.all([
      listTeamRequests(user.id, { status: 'all', limit: 200 }),
      listPendingForumUploads(user.id, { limit: UPLOADS_SHOWN }),
    ]);
    // pendingUploadCount (the badge total) may exceed what we render — tell the
    // owner the rest appear as they drain the front of the queue.
    const moreUploads = Math.max(0, pendingUploadCount - uploads.length);
    return (
      <div className="flex h-full flex-col">
        <SetPageTitle title="Team" />
        <TeamTabs active="requests" openRequestCount={openRequestCount} />
        <RequestsPanel requests={requests} uploads={uploads} moreUploads={moreUploads} />
      </div>
    );
  }

  const ACTIVITY_PAGE_SIZE = 25;
  const ARCHIVE_SHOWN = 50;
  const selectedId =
    contact && members.some((m) => m.contactId === contact)
      ? contact
      : (members[0]?.contactId ?? null);
  const selected = members.find((m) => m.contactId === selectedId) ?? null;
  const activityPage = Math.max(1, Number.parseInt(apage ?? '1', 10) || 1);

  let posts: ForumMemberPost[] = [];
  let postTotal = 0;
  let authored: ForumAuthoredTopic[] = [];
  let memberRequests: TeamRequest[] = [];
  let thread: Awaited<ReturnType<typeof listTeamThread>> = [];
  let access: Awaited<ReturnType<typeof listTeamAccess>> = [];

  if (selectedId && selected) {
    [posts, postTotal, authored, memberRequests, thread, access] = await Promise.all([
      listForumPostsByContact(user.id, selectedId, {
        limit: ACTIVITY_PAGE_SIZE,
        offset: (activityPage - 1) * ACTIVITY_PAGE_SIZE,
      }),
      countForumPostsByContact(user.id, selectedId),
      listForumTopicsByAuthor(user.id, selectedId, { limit: 20 }),
      listTeamRequests(user.id, { status: 'all', limit: 50, contactId: selectedId }),
      // Only touch the frozen chat store when this member actually has an
      // archive — on a post-Forum brain that query would always return [].
      selected.messageCount > 0
        ? listTeamThread(user.id, selectedId, { limit: ARCHIVE_SHOWN })
        : Promise.resolve([]),
      listTeamAccess(user.id, { contactId: selectedId, limit: 50 }),
    ]);
    // Advance the CHAT cursor only for members carrying an archive: pre-Forum
    // threads can still hold unread rows, and `team_chat_list` reports them to
    // the assistant. A brain that never had chat never gets a write.
    // The forum unread badge is deliberately NOT cleared here — that belongs
    // to opening the topic, on the Topics tab.
    if (selected.messageCount > 0) await markTeamThreadRead(user.id, selectedId);
  }

  return (
    <div className="flex h-full flex-col">
      <SetPageTitle title="Team" />
      <TeamTabs active="members" openRequestCount={openRequestCount} />
      <div className="min-h-0 flex-1 md:grid md:grid-cols-[340px_1fr]">
        {/* Members */}
        <aside className="flex min-h-0 flex-col border-r border-border">
          <div className="flex items-baseline gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Team members</h2>
            {members.length > 0 && (
              <span className="text-xs text-muted-foreground">{members.length}</span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <MemberList members={members} selectedId={selectedId} />
          </div>
        </aside>

        {/* Activity */}
        <section className="flex min-h-0 flex-col">
          {selected ? (
            <>
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold">{selected.contactName}</h2>
                  <p className="text-xs text-muted-foreground">
                    {postTotal} {postTotal === 1 ? 'post' : 'posts'} ·{' '}
                    {selected.forum?.topicsStarted ?? 0} started · member since{' '}
                    {fmtWhen(selected.memberSince)} · token last used{' '}
                    {fmtWhen(selected.tokenLastUsedAt)}
                  </p>
                </div>
                <Link
                  href={`/contacts?selected=${selected.contactId}`}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  Manage token →
                </Link>
              </div>
              <ThreadAccessSplit
                thread={
                  <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                    <div className="mx-auto w-full max-w-3xl space-y-5 p-4">
                      {memberRequests.length > 0 && <MemberRequestList requests={memberRequests} />}
                      {authored.length > 0 && <AuthoredTopics topics={authored} />}
                      <section className="space-y-2">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Posts &amp; answers
                        </h3>
                        {posts.length === 0 ? (
                          <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                            {selected.messageCount > 0
                              ? 'Nothing in the Forum yet — their conversation predates it. The archive is below.'
                              : `${selected.contactName} hasn’t posted in the Forum yet.`}
                          </p>
                        ) : (
                          <>
                            <ul className="flex flex-col gap-3">
                              {posts.map((p) => (
                                <ActivityPost key={p.id} post={p} />
                              ))}
                            </ul>
                            {postTotal > ACTIVITY_PAGE_SIZE && (
                              <MemberActivityPager
                                page={activityPage}
                                total={postTotal}
                                pageSize={ACTIVITY_PAGE_SIZE}
                              />
                            )}
                          </>
                        )}
                      </section>
                      {selected.messageCount > 0 && (
                        <ChatArchive thread={thread} count={selected.messageCount} />
                      )}
                    </div>
                  </div>
                }
                access={
                  access.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No access events yet.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {access.map((a) => (
                        <li
                          key={a.id}
                          className="flex items-center gap-2 text-xs text-muted-foreground"
                        >
                          <span className="w-14 shrink-0 font-medium text-foreground">
                            {a.kind}
                          </span>
                          <span className="truncate">{JSON.stringify(a.detail)}</span>
                          <span className="ml-auto shrink-0">{fmtWhen(a.createdAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )
                }
              />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center text-sm text-muted-foreground">
                <Users className="mx-auto mb-2 size-6" />
                <p>Enable a contact as a team member to see their activity here.</p>
                <p className="mt-1 text-xs">
                  Their token is what unlocks <code>/team</code>.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
