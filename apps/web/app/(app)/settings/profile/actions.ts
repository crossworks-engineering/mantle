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
  if (!timezone && !locale) {
    throw new Error('Set timezone or locale (or both) before saving.');
  }
  await updateProfilePreferences(user.id, {
    ...(timezone ? { timezone } : {}),
    ...(locale ? { locale } : {}),
  });
  // Lots of pages render dates — refresh the cache so the new
  // timezone takes effect immediately on next nav rather than after
  // a hard reload.
  revalidatePath('/', 'layout');
}
