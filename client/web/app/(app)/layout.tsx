import { cookies } from 'next/headers';
import { AppShell } from '@/components/app-shell';

/**
 * App shell: header on top, sidebar on the left, live-activity column on the
 * right, content in the middle.
 *
 * ZERO-SECRET variant — this app cannot verify a session (no SESSION_SECRET,
 * no DB), so there is NO server-side auth or onboarding gate here. This is
 * the detached-dev branch of the old monolith layout made permanent:
 *   - auth UX     → client middleware (presence cookie → /login redirect)
 *   - enforcement → the server origin's 401s on every data fetch (apiFetch
 *                   bounces to /login and clears the token store)
 *   - onboarding  → AppShell's client redirect off GET /api/shell
 *   - UsageCard   → dropped (it read the DB in-process); its data can come
 *                   via an API route later if wanted
 *
 * The collapse cookies are pure request-state UX (flash-free first paint) —
 * reading them needs no secret.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const navCollapsed = cookieStore.get('mantle_nav_collapsed')?.value === '1';
  // Activity defaults to collapsed — only an explicit '0' (user expanded it) opens it.
  const activityCollapsed = cookieStore.get('mantle_activity_collapsed')?.value !== '0';

  return (
    <AppShell
      email={null}
      contextCard={null}
      initialNavCollapsed={navCollapsed}
      initialActivityCollapsed={activityCollapsed}
    >
      {children}
    </AppShell>
  );
}
