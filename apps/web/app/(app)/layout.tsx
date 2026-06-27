import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { requireOwner } from '@/lib/auth';
import { AppShell } from '@/components/app-shell';
import { UsageCard } from '@/components/usage-card';

/**
 * App shell: header on top, sidebar (context+cost card + nav + branches)
 * on the left, live-activity column on the right, content in the middle.
 * Everything under `(app)/` requires a logged-in owner.
 *
 * Data-free: this layout does auth (`requireOwner`) and reads the collapse
 * cookies (request state, not the DB) for a flash-free first paint — nothing
 * else. The avatar, the pending-approvals badge, and the onboarding gate are
 * fetched client-side by `AppShell` via `GET /api/shell`, so the shell renders
 * with no in-process DB access (Electron / DB-less ready).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireOwner();

  // Persisted collapse state — read server-side so the shell renders at the
  // right width on first paint (no expand→collapse flash). Toggled client-side
  // (AppShell writes the same cookies).
  const cookieStore = await cookies();
  const navCollapsed = cookieStore.get('mantle_nav_collapsed')?.value === '1';
  const activityCollapsed = cookieStore.get('mantle_activity_collapsed')?.value === '1';

  return (
    <AppShell
      email={user.email ?? null}
      // Own Suspense boundary: UsageCard is an async server component, and
      // without a local boundary its SSR suspension bubbles to the route
      // boundary, putting the whole shell (incl. the header) under a streaming
      // boundary that's absent at client hydration — which shifts every radix
      // `useId` in the shell and trips a hydration-id mismatch. Containing it
      // here keeps the rest of the shell's tree-context symmetric.
      contextCard={
        <Suspense fallback={null}>
          <UsageCard ownerId={user.id} />
        </Suspense>
      }
      initialNavCollapsed={navCollapsed}
      initialActivityCollapsed={activityCollapsed}
    >
      {children}
    </AppShell>
  );
}
