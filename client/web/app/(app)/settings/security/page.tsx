import { redirect } from 'next/navigation';

/**
 * Settings → Security was folded into Settings → Logins. Its two panels went
 * different ways: the self-serve password change was a duplicate of the Logins
 * password reset (same `updatePassword`, differing only in the old-password
 * challenge), and the signed-in devices list moved to the Logins detail panel,
 * where it can be read per login instead of only for the caller.
 *
 * Kept as a stub because the route was linked from help text and bookmarks.
 */
export default function SecuritySettingsRedirect() {
  redirect('/settings/users');
}
