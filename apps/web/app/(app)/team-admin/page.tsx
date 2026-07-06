import Link from 'next/link';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import {
  listTeamMemberActivity,
  listTeamThread,
  listTeamAccess,
  type TeamMemberActivity,
} from '@mantle/content';
import { MessageSquare, ScrollText, ExternalLink } from 'lucide-react';
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
              'block rounded-md border border-transparent px-3 py-2 transition-colors',
              m.contactId === selectedId
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-foreground/[0.06]',
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium">{m.contactName}</span>
              <span
                className={cn(
                  'shrink-0 text-xs',
                  m.contactId === selectedId ? 'text-accent-foreground/80' : 'text-muted-foreground',
                )}
              >
                {fmtWhen(m.lastMessageAt)}
              </span>
            </div>
            <p
              className={cn(
                'mt-0.5 truncate text-xs',
                m.contactId === selectedId ? 'text-accent-foreground/80' : 'text-muted-foreground',
              )}
            >
              {m.lastMessageText ?? `member since ${fmtWhen(m.memberSince)} — no messages yet`}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function TeamAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ contact?: string }>;
}) {
  const user = await requireOwner();
  const { contact } = await searchParams;

  const members = await listTeamMemberActivity(user.id);
  const selectedId =
    contact && members.some((m) => m.contactId === contact)
      ? contact
      : (members[0]?.contactId ?? null);
  const selected = members.find((m) => m.contactId === selectedId) ?? null;
  const [thread, access] = selectedId
    ? await Promise.all([
        listTeamThread(user.id, selectedId, { limit: 50 }),
        listTeamAccess(user.id, { contactId: selectedId, limit: 15 }),
      ])
    : [[], []];

  return (
    <>
      <SetPageTitle title="Team" />
      <div className="h-full md:grid md:grid-cols-[340px_1fr]">
        {/* Members */}
        <aside className="flex min-h-0 flex-col border-r border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Team members</h2>
            <Link
              href="/tasks"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              Team requests →
            </Link>
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
                    {selected.messageCount} messages · member since {fmtWhen(selected.memberSince)} ·
                    token last used {fmtWhen(selected.tokenLastUsedAt)}
                  </p>
                </div>
                <Link
                  href={`/contacts?selected=${selected.contactId}`}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  Manage token →
                </Link>
              </div>
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
                            <p className="text-sm text-destructive">Turn failed: {m.error ?? 'unknown error'}</p>
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
                )}
              </div>
              <div className="border-t border-border px-4 py-3">
                <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <ScrollText className="size-3.5" /> Recent access
                </h3>
                {access.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No access events yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {access.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="w-14 shrink-0 font-medium text-foreground">{a.kind}</span>
                        <span className="truncate">{JSON.stringify(a.detail)}</span>
                        <span className="ml-auto shrink-0">{fmtWhen(a.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
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
    </>
  );
}
