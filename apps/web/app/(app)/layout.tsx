import Link from 'next/link';
import { and, eq, sql } from 'drizzle-orm';
import { Inbox, Settings, TreePine, UserCheck } from 'lucide-react';
import { db, emailSenders } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { TreeRail } from '@/components/tree-rail';
import { TopBar } from '@/components/top-bar';

/**
 * App shell: tree rail on the left, top bar on top, content in the middle.
 * Everything under `(app)/` requires a logged-in owner.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireOwner();

  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailSenders)
    .where(and(eq(emailSenders.userId, user.id), eq(emailSenders.status, 'pending')));
  const pendingCount = pending?.n ?? 0;

  return (
    <div className="grid h-screen grid-cols-[260px_1fr] grid-rows-[48px_1fr] bg-background">
      <aside className="row-span-2 flex flex-col border-r border-border bg-muted/30">
        <div className="flex h-12 items-center gap-2 border-b border-border px-4">
          <TreePine className="size-4" aria-hidden />
          <span className="text-sm font-semibold">Mantle</span>
        </div>
        <nav className="flex flex-col gap-px p-2 text-sm">
          <Link href="/" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
            <Inbox className="size-4" aria-hidden /> Inbox
          </Link>
          <Link
            href="/settings/senders"
            className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
          >
            <UserCheck className="size-4" aria-hidden />
            <span>Senders</span>
            {pendingCount > 0 && (
              <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                {pendingCount}
              </span>
            )}
          </Link>
          <Link
            href="/settings/accounts"
            className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
          >
            <Settings className="size-4" aria-hidden /> Settings
          </Link>
        </nav>
        <div className="mt-2 flex-1 overflow-auto px-2 pb-2">
          <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Branches
          </p>
          <TreeRail ownerId={user.id} />
        </div>
      </aside>

      <TopBar email={user.email ?? null} />

      <main className="overflow-auto">{children}</main>
    </div>
  );
}
