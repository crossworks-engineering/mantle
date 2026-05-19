import Link from 'next/link';
import { and, eq, sql } from 'drizzle-orm';
import { Activity, Bot, CalendarDays, CheckSquare, ClipboardCheck, Cpu, FileText, FolderTree, Hammer, Inbox, Key, KeyRound, Lock, MessageCircle, Settings, Sparkles, TreePine, User, UserCheck, Workflow } from 'lucide-react';
import { db, emailSenders } from '@mantle/db';
import { countPending } from '@mantle/tools';
import { requireOwner } from '@/lib/auth';
import { TreeRail } from '@/components/tree-rail';
import { TopBar } from '@/components/top-bar';
import { AppShell } from '@/components/app-shell';

/**
 * App shell: tree rail on the left, top bar on top, content in the middle.
 * Everything under `(app)/` requires a logged-in owner.
 *
 * Layout work (mobile drawer, responsive grid) lives in <AppShell>; this
 * server component just gathers the data + renders the static parts.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireOwner();

  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailSenders)
    .where(and(eq(emailSenders.userId, user.id), eq(emailSenders.status, 'pending')));
  const pendingCount = pending?.n ?? 0;
  const pendingApprovals = await countPending(user.id);

  const sidebar = (
    <>
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <TreePine className="size-4" aria-hidden />
        <span className="text-sm font-semibold">Mantle</span>
      </div>
      <nav className="flex flex-col gap-px p-2 text-sm">
        <Link href="/" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <Inbox className="size-4" aria-hidden /> Inbox
        </Link>
        <Link href="/assistant" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <MessageCircle className="size-4" aria-hidden /> Assistant
        </Link>
        <Link href="/files" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <FolderTree className="size-4" aria-hidden /> Files
        </Link>
        <Link href="/notes" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <FileText className="size-4" aria-hidden /> Notes
        </Link>
        <Link href="/todos" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <CheckSquare className="size-4" aria-hidden /> Todos
        </Link>
        <Link href="/events" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <CalendarDays className="size-4" aria-hidden /> Events
        </Link>
        <Link href="/secrets" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <Lock className="size-4" aria-hidden /> Secrets
        </Link>
        <Link href="/settings/senders" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <UserCheck className="size-4" aria-hidden />
          <span>Senders</span>
          {pendingCount > 0 && (
            <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
              {pendingCount}
            </span>
          )}
        </Link>
        <Link href="/settings/accounts" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <Settings className="size-4" aria-hidden /> Settings
        </Link>
        <Link href="/settings/profile" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <User className="size-4" aria-hidden /> Profile
        </Link>
        <Link href="/settings/keys" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <Key className="size-4" aria-hidden /> API keys
        </Link>
        <Link href="/settings/agents" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <Bot className="size-4" aria-hidden /> Agents
        </Link>
        <Link href="/settings/ai-workers" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <Cpu className="size-4" aria-hidden /> AI workers
        </Link>
        <Link href="/settings/tools" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <Hammer className="size-4" aria-hidden /> Tools
        </Link>
        <Link href="/settings/skills" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <Sparkles className="size-4" aria-hidden /> Skills
        </Link>
        <Link href="/pending" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <ClipboardCheck className="size-4" aria-hidden />
          <span>Pending</span>
          {pendingApprovals > 0 && (
            <span className="ml-auto rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-900 dark:bg-rose-900/40 dark:text-rose-100">
              {pendingApprovals}
            </span>
          )}
        </Link>
        <Link href="/traces" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <Workflow className="size-4" aria-hidden /> Traces
        </Link>
        <Link href="/debug" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <Activity className="size-4" aria-hidden /> Debug
        </Link>
        <Link href="/settings/security" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <KeyRound className="size-4" aria-hidden /> Security
        </Link>
      </nav>
      <div className="mt-2 flex-1 overflow-auto px-2 pb-2">
        <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Branches
        </p>
        <TreeRail ownerId={user.id} />
      </div>
    </>
  );

  return (
    <AppShell sidebar={sidebar} topbar={<TopBar email={user.email ?? null} />}>
      {children}
    </AppShell>
  );
}
