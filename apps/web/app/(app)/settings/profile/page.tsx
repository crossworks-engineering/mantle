import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { ProfileClient } from './profile-client';

/**
 * /settings/profile — the operator's own preferences (auth gate only).
 *
 * Preferences, the reminder-capable agent list, and the owner id are fetched
 * client-side via `GET /api/profile` (Phase 2 · Task 4), so the screen carries
 * no in-process DB read. The "now in your settings" sample is computed live in
 * the client from the chosen tz/locale.
 */
export default async function ProfilePage() {
  await requireOwner();
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
      <SetPageTitle title="Profile" />
      <ProfileClient />
    </div>
  );
}
