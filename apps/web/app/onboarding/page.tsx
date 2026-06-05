import { redirect } from 'next/navigation';
import { and, db, agents, eq } from '@mantle/db';
import { loadProfilePreferences } from '@mantle/content';
import { listApiKeys } from '@mantle/api-keys';
import { requireOwner } from '@/lib/auth';
import { isOnboarded } from '@/lib/onboarding';
import { PERSONA_AGENT_SLUG } from '@/lib/onboarding-provision';
import { OnboardingClient } from './onboarding-client';

/**
 * First-run wizard entry. Requires a session (the layout enforces it). If the
 * user is already onboarded (flag set, or an existing install with an agent),
 * there's nothing to do — send them to the app. Otherwise hand the client its
 * resume state.
 *
 * `?force=1` bypasses the "already onboarded" redirect so an existing install
 * can preview / re-run the wizard (owner-scoped + idempotent, so it's safe to
 * expose). Handy for testing on a populated stack.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ force?: string }>;
}) {
  const user = await requireOwner();
  const force = (await searchParams).force === '1';
  if (!force && (await isOnboarded(user.id))) redirect('/');
  const prefs = await loadProfilePreferences(user.id);

  const keys = await listApiKeys(user.id);
  const savedServices = [...new Set(keys.map((k) => k.service))];

  // The persona agent's id (once provisioned) — the Telegram step binds a bot to
  // it via the same `/api/agents/[id]/telegram` flow the settings page uses.
  const [assistantAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, user.id), eq(agents.slug, PERSONA_AGENT_SLUG)))
    .limit(1);

  return (
    <OnboardingClient
      initialStep={prefs.onboardingStep ?? 'profile'}
      initialTimezone={prefs.timezone}
      initialLocale={prefs.locale}
      savedServices={savedServices}
      assistantAgentId={assistantAgent?.id ?? null}
    />
  );
}
