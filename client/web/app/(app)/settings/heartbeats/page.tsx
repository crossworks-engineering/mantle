import { SetPageTitle } from '@/components/layout/page-title';
import { HeartbeatsClient } from './heartbeats-client';

/**
 * /settings/heartbeats — proactive control surface (auth gate only).
 *
 * Heartbeats, the agent catalogue, and skills are all fetched client-side via
 * TanStack Query against `/api/**` (Phase 2 · Task 4), so the screen carries no
 * in-process DB read. Next-fire timestamps are formatted client-side with the
 * shared `formatDateTime` (no SSR pass = no hydration mismatch to guard).
 */
export default async function HeartbeatsPage() {
  return (
    <>
      <SetPageTitle title="Heartbeats" />
      <HeartbeatsClient />
    </>
  );
}
