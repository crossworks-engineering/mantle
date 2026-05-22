import { requireOwner } from '@/lib/auth';
import {
  DEFAULT_PREFERENCES,
  loadProfilePreferences,
  formatInProfile,
} from '@mantle/content';
import { SetPageTitle } from '@/components/layout/page-title';
import { ProfileClient } from './profile-client';
import { updatePreferencesAction } from './actions';

/**
 * /settings/profile — the operator's own preferences.
 *
 * Two fields today: timezone (IANA) + locale (BCP-47). Both feed:
 *   - Date formatting in the UI (formatDateTime + format-aware
 *     components),
 *   - Saskia's system-prompt time context, so she resolves "tomorrow
 *     at 3pm" correctly when calling event_create.
 *
 * Loaders are owner-scoped via requireOwner(). The page auto-creates
 * the profile row on first visit (see loadProfilePreferences).
 */
export default async function ProfilePage() {
  const user = await requireOwner();
  const prefs = await loadProfilePreferences(user.id);
  // Render a sample "this is what now() looks like" so the operator
  // sees the effect of the chosen settings before saving anything
  // else that depends on them.
  const samplePreview = formatInProfile(new Date(), prefs, {
    dateStyle: 'full',
    timeStyle: 'long',
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
      <SetPageTitle title="Profile" />

      <ProfileClient
        defaults={prefs}
        defaultsFallback={DEFAULT_PREFERENCES}
        samplePreview={samplePreview}
        userId={user.id}
        action={updatePreferencesAction}
      />
    </div>
  );
}
