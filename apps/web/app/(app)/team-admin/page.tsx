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
  listForumTopics,
  countForumTopics,
  listForumPosts,
  getForumTopic,
  markForumTopicRead,
  listForumUploadStatesForTopic,
  listPendingForumUploads,
  countPendingForumUploads,
  formatAttachmentSize,
  type TeamMemberActivity,
  type TeamRequest,
  type ForumTopicListItem,
  type PendingForumUpload,
} from '@mantle/content';
import { reconcileForumQuarantine } from '@/lib/forum-quarantine';
import { SharedLinksPanel } from '@/components/share/shared-links-panel';
import { HubAppPicker } from '@/components/team-chat/hub-app-picker';
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
  MessageSquare,
  MessagesSquare,
  ExternalLink,
  Inbox,
  CheckCircle2,
  Paperclip,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * /team-admin — the owner's window into the external Team Chat surface
 * (decision: a dedicated route, room to grow into the team-platform hub).
 * Master-detail: left = team members ordered by recent activity; right = the
 * selected member's thread (read-only) with per-turn trace deep-links, plus
 * their recent access-log entries. Token mint/rotate/revoke stays on the
 * contact's page (linked) — one lifecycle surface, not two.
 *
 * Server-rendered + URL-driven (?contact=<id>), matching the list-screen
 * conventions; the thread itself is a preview, not a live chat.
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

function MemberList({
  members,
  selectedId,
}: {
  members: TeamMemberActivity[];
  selectedId: string | null;
}) {
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
                {m.unread > 0 ? (
                  <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                    {m.unread}
                  </span>
                ) : null}
                {fmtWhen(m.lastMessageAt)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {m.lastMessageText ?? `member since ${fmtWhen(m.memberSince)} — no messages yet`}
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
  active: 'chats' | 'topics' | 'requests' | 'shares';
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
      {tab('Chats', '/team-admin', active === 'chats')}
      {tab('Topics', '/team-admin?view=topics', active === 'topics')}
      {tab('Requests', '/team-admin?view=requests', active === 'requests', openRequestCount)}
      {tab('Shared links', '/team-admin?view=shares', active === 'shares')}
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

export default async function TeamAdminPage({
  searchParams,
}: {
  searchParams: Promise<{
    contact?: string;
    view?: string;
    topic?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const user = await requireOwner();
  const { contact, view, topic: topicParam, q, page } = await searchParams;
  const showRequests = view === 'requests';

  const [members, prefs, openRequests, apps, pendingUploadCount] = await Promise.all([
    listTeamMemberActivity(user.id),
    loadProfilePreferences(user.id),
    listTeamRequests(user.id, { status: 'open' }).then((r) => r.length),
    listApps(user.id, { limit: 200 }),
    countPendingForumUploads(user.id),
  ]);
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

  const selectedId =
    contact && members.some((m) => m.contactId === contact)
      ? contact
      : (members[0]?.contactId ?? null);
  const selected = members.find((m) => m.contactId === selectedId) ?? null;
  const [thread, access] = selectedId
    ? await Promise.all([
        listTeamThread(user.id, selectedId, { limit: 50 }),
        listTeamAccess(user.id, { contactId: selectedId, limit: 50 }),
      ])
    : [[], []];
  // Viewing a member's thread marks it read up to now; reflect that in this
  // render so the selected member's unread badge clears immediately (the DB
  // cursor drives it on the next navigation).
  if (selectedId && selected) {
    await markTeamThreadRead(user.id, selectedId);
    selected.unread = 0;
  }

  return (
    <div className="flex h-full flex-col">
      <SetPageTitle title="Team" />
      <TeamTabs active="chats" openRequestCount={openRequestCount} />
      <div className="min-h-0 flex-1 md:grid md:grid-cols-[340px_1fr]">
        {/* Members */}
        <aside className="flex min-h-0 flex-col border-r border-border">
          <div className="flex items-center border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Team members</h2>
          </div>
          {/* Surface-wide read posture. Members always get brain-knowledge reads;
              this gates the owner's PRIVATE corpus (email + journal). Default off. */}
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <PrivateReadsToggle initial={privateReads} />
          </div>
          {/* Which app (if any) renders as the members' hub on /team. Keyed by
              the current designation so a server-side change (another tab, MCP)
              resyncs the Select on refresh instead of holding stale state. */}
          <div className="border-b border-border px-4 py-3">
            <HubAppPicker
              key={hubAppId ?? 'builtin'}
              currentAppId={hubAppId}
              apps={hubCandidates}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <MemberList members={members} selectedId={selectedId} />
          </div>
        </aside>

        {/* Thread preview */}
        <section className="flex min-h-0 flex-col">
          {selected ? (
            <>
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold">{selected.contactName}</h2>
                  <p className="text-xs text-muted-foreground">
                    {selected.messageCount} messages · member since {fmtWhen(selected.memberSince)}{' '}
                    · token last used {fmtWhen(selected.tokenLastUsedAt)}
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
                  <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 py-4">
                    {thread.length === 0 ? (
                      <p className="py-8 text-center text-sm text-muted-foreground">
                        No messages yet — they haven’t started chatting.
                      </p>
                    ) : (
                      <div className="mx-auto flex max-w-3xl flex-col gap-3">
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
                            <div
                              key={m.id}
                              className="mr-auto w-full max-w-[85%] rounded-lg bg-card px-3 py-2 text-card-foreground"
                            >
                              {m.status === 'failed' ? (
                                <p className="text-sm text-destructive">
                                  Turn failed: {m.error ?? 'unknown error'}
                                </p>
                              ) : (
                                <div className="prose prose-accent prose-sm max-w-none dark:prose-invert">
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {m.text}
                                  </ReactMarkdown>
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
                    )}
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
                <MessageSquare className="mx-auto mb-2 size-6" />
                <p>Enable a contact as a team member to open this brain’s Team Chat.</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
