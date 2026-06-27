import { NextResponse } from 'next/server';
import { countPending } from '@mantle/tools';
import { loadProfilePreferences } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { isOnboarded } from '@/lib/onboarding';

/**
 * Chrome data for the (app) shell — the avatar, the pending-approvals badge
 * count, and the onboarding gate — fetched client-side by `AppShell` so the
 * `(app)/layout.tsx` itself stays data-free (auth + collapse cookies only) and
 * the same shell is loadable by a detached client (Electron / DB-less). The
 * three reads that used to run in-process during layout render now live behind
 * this one HTTP round-trip. `isOnboarded` is idempotent (it self-stamps an
 * established install), so it's safe in a GET.
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const prefs = await loadProfilePreferences(user.id);
  const [onboarded, pendingApprovals] = await Promise.all([
    isOnboarded(user.id, prefs),
    countPending(user.id),
  ]);
  const avatar = prefs.avatarStyle
    ? { style: prefs.avatarStyle, seed: prefs.avatarSeed || user.id }
    : null;
  return NextResponse.json({ onboarded, avatar, pendingApprovals });
}
