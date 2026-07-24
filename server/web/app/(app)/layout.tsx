import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireOwner } from '@/lib/auth';
import { isDetachedDev } from '@/lib/auth-constants';
import { isOnboarded } from '@/lib/onboarding';
import { AppShell } from '@/components/app-shell';
import { UsageCard } from '@/components/usage-card';

/**
 * App shell: header on top, sidebar (context+cost card + nav + branches)
 * on the left, live-activity column on the right, content in the middle.
 * Everything under `(app)/` requires a logged-in owner.
 *
 * Near-data-free: this layout does auth (`requireOwner`), one onboarding-gate
 * read, and the collapse cookies (request state) for a flash-free first paint.
 * The avatar + pending-approvals badge are still fetched client-side by
 * `AppShell` via `GET /api/shell`. The onboarding gate is enforced server-side
 * HERE (not only in AppShell) so an un-provisioned user can't render protected
 * pages before a client redirect, and so the gate can't fail open if
 * `/api/shell` errors. AppShell keeps a client redirect too, for the detached
 * client that renders against a remote API and never executes this server tree.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireOwner();

  // Server-side onboarding gate: a freshly-signed-up owner who hasn't finished
  // the wizard has no provisioned brain, so don't render the app over them —
  // send them to /onboarding (which lives OUTSIDE this (app) group, so no loop).
  // Skipped in detached dev (no local DB; the remote brain is already onboarded).
  const detached = isDetachedDev();
  if (!detached && !(await isOnboarded(user.id))) redirect('/onboarding');

  // Persisted collapse state — read server-side so the shell renders at the
  // right width on first paint (no expand→collapse flash). Toggled client-side
  // (AppShell writes the same cookies).
  const cookieStore = await cookies();
  const navCollapsed = cookieStore.get('mantle_nav_collapsed')?.value === '1';
  // Activity defaults to collapsed — only an explicit '0' (user expanded it) opens it.
  const activityCollapsed = cookieStore.get('mantle_activity_collapsed')?.value !== '0';

  return (
    <AppShell
      email={user.email ?? null}
      // Own Suspense boundary: UsageCard is an async server component, and
      // without a local boundary its SSR suspension bubbles to the route
      // boundary, putting the whole shell (incl. the header) under a streaming
      // boundary that's absent at client hydration — which shifts every radix
      // `useId` in the shell and trips a hydration-id mismatch. Containing it
      // here keeps the rest of the shell's tree-context symmetric.
      // UsageCard reads the DB in-process (spend + agent context), which a
      // detached frontend doesn't have — drop it there rather than 500 the shell.
      contextCard={
        detached ? null : (
          <Suspense fallback={null}>
            <UsageCard ownerId={user.id} />
          </Suspense>
        )
      }
      initialNavCollapsed={navCollapsed}
      initialActivityCollapsed={activityCollapsed}
    >
      {children}
    </AppShell>
  );
}
