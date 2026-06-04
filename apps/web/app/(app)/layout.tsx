import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { countPending } from '@mantle/tools';
import { loadProfilePreferences } from '@mantle/content';
import { requireOwner } from '@/lib/auth';
import { AppShell } from '@/components/app-shell';
import { UsageCard } from '@/components/usage-card';

/**
 * App shell: header on top, sidebar (context+cost card + nav + branches)
 * on the left, live-activity column on the right, content in the middle.
 * Everything under `(app)/` requires a logged-in owner.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireOwner();

  const prefs = await loadProfilePreferences(user.id);
  // First-run gate: a logged-in but not-yet-onboarded user is sent to the wizard
  // (which lives outside this (app) group, so no redirect loop). See lib/onboarding.ts.
  if (!prefs.onboardedAt) redirect('/onboarding');

  const pendingApprovals = await countPending(user.id);

  const userAvatar = prefs.avatarStyle
    ? { style: prefs.avatarStyle, seed: prefs.avatarSeed || user.id }
    : null;

  // Persisted collapse state — read server-side so the shell renders at the
  // right width on first paint (no expand→collapse flash). Toggled client-side
  // (AppShell writes the same cookies).
  const cookieStore = await cookies();
  const navCollapsed = cookieStore.get('mantle_nav_collapsed')?.value === '1';
  const activityCollapsed = cookieStore.get('mantle_activity_collapsed')?.value === '1';

  return (
    <AppShell
      email={user.email ?? null}
      userAvatar={userAvatar}
      pendingApprovals={pendingApprovals}
      contextCard={<UsageCard ownerId={user.id} />}
      initialNavCollapsed={navCollapsed}
      initialActivityCollapsed={activityCollapsed}
    >
      {children}
    </AppShell>
  );
}
