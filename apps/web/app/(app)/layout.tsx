import { and, eq, sql } from 'drizzle-orm';
import { db, emailSenders } from '@mantle/db';
import { countPending } from '@mantle/tools';
import { loadProfilePreferences } from '@mantle/content';
import { requireOwner } from '@/lib/auth';
import { TreeRail } from '@/components/tree-rail';
import { AppShell } from '@/components/app-shell';
import { UsageCard } from '@/components/usage-card';
import { avatarDataUri } from '@/lib/dicebear';

/**
 * App shell: header on top, sidebar (context+cost card + nav + branches)
 * on the left, live-activity column on the right, content in the middle.
 * Everything under `(app)/` requires a logged-in owner.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireOwner();

  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailSenders)
    .where(and(eq(emailSenders.userId, user.id), eq(emailSenders.status, 'pending')));
  const pendingCount = pending?.n ?? 0;
  const pendingApprovals = await countPending(user.id);

  const prefs = await loadProfilePreferences(user.id);
  const userAvatar = prefs.avatarStyle
    ? avatarDataUri(prefs.avatarStyle, prefs.avatarSeed || user.id)
    : null;

  return (
    <AppShell
      email={user.email ?? null}
      userAvatar={userAvatar}
      pendingSenders={pendingCount}
      pendingApprovals={pendingApprovals}
      contextCard={<UsageCard ownerId={user.id} />}
      tree={<TreeRail ownerId={user.id} />}
    >
      {children}
    </AppShell>
  );
}
