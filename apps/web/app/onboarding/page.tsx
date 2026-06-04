import { redirect } from 'next/navigation';
import { loadProfilePreferences } from '@mantle/content';
import { listApiKeys } from '@mantle/api-keys';
import { requireOwner } from '@/lib/auth';
import { OnboardingClient } from './onboarding-client';

/**
 * First-run wizard entry. Requires a session (the layout enforces it). If the
 * user is already onboarded there's nothing to do — send them to the app.
 * Otherwise hand the client its resume state.
 */
export default async function OnboardingPage() {
  const user = await requireOwner();
  const prefs = await loadProfilePreferences(user.id);
  if (prefs.onboardedAt) redirect('/');

  const keys = await listApiKeys(user.id);
  const savedServices = [...new Set(keys.map((k) => k.service))];

  return (
    <OnboardingClient
      initialStep={prefs.onboardingStep ?? 'profile'}
      initialTimezone={prefs.timezone}
      initialLocale={prefs.locale}
      savedServices={savedServices}
    />
  );
}
