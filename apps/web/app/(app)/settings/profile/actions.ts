'use server';

/**
 * Profile preferences server action — single mutation surface for the
 * /settings/profile form. The actual persistence + validation lives
 * in @mantle/content (so apps/agent can read the same prefs); the
 * action here is the tiny wrapper that scopes to the auth'd user.
 */

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/lib/auth';
import { updateProfilePreferences } from '@mantle/content';

export async function updatePreferencesAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const timezone = String(formData.get('timezone') ?? '').trim();
  const locale = String(formData.get('locale') ?? '').trim();
  // Avatar fields are always present in the form (possibly empty when the
  // user chose the initials fallback). Empty string clears it — the loader
  // treats empty as "unset".
  const avatarStyle = String(formData.get('avatarStyle') ?? '').trim();
  const avatarSeed = String(formData.get('avatarSeed') ?? '').trim();
  // Email send allowlist: one entry per line (or comma). Empty ⇒ gate off.
  const emailAllowlist = String(formData.get('emailAllowlist') ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!timezone && !locale) {
    throw new Error('Set timezone or locale (or both) before saving.');
  }
  await updateProfilePreferences(user.id, {
    ...(timezone ? { timezone } : {}),
    ...(locale ? { locale } : {}),
    avatarStyle,
    avatarSeed,
    emailAllowlist,
  });
  // Lots of pages render dates — refresh the cache so the new
  // timezone takes effect immediately on next nav rather than after
  // a hard reload.
  revalidatePath('/', 'layout');
}
