/**
 * Resolve which agent the editor "Assist" panels delegate to.
 *
 * The `/pages` and `/tables` editors each have an in-surface Assist panel that
 * invokes a specialist agent directly (skipping the Saskia hop). Which agent it
 * uses is configurable ON THE SURFACE ITSELF — a picker in the Assist panel
 * writes `profiles.preferences.{pagesAssistAgentSlug,tablesAssistAgentSlug}`.
 *
 * Resolution order: the saved preference (if it maps to an enabled, owned agent)
 * → the default specialist slug (`pages` / `tables`, seeded during onboarding) →
 * null. A null result means no usable agent exists yet (e.g. onboarding hasn't
 * provisioned the specialists, or the picked agent was deleted/disabled); the
 * route turns that into a friendly "set up a Pages/Tables assistant" message
 * rather than a raw 500 from `invokeAgent`.
 */

import { db, agents, and, eq } from '@mantle/db';
import { loadProfilePreferences } from '@mantle/content';
import { ASSIST_SURFACE_DEFAULTS } from '@/lib/system-manifest/manifest';

export type AssistSurface = 'pages' | 'tables';

/** The specialist slug each surface defaults to — derived from the manifest
 *  (single source of truth), so adding/renaming an Assist specialist is one
 *  manifest edit, not a hardcoded list here. */
export const DEFAULT_ASSIST_SLUG: Record<AssistSurface, string> = ASSIST_SURFACE_DEFAULTS;

/**
 * Returns the slug of the enabled, owned agent the surface's Assist panel should
 * invoke, or null if neither the preferred nor the default agent exists.
 */
export async function resolveAssistAgentSlug(
  ownerId: string,
  surface: AssistSurface,
): Promise<string | null> {
  const prefs = await loadProfilePreferences(ownerId);
  const preferred =
    surface === 'pages' ? prefs.pagesAssistAgentSlug : prefs.tablesAssistAgentSlug;

  // Try the saved preference first, then the default specialist. Dedupe so we
  // don't probe the same slug twice when the preference IS the default.
  const candidates = [...new Set(
    [preferred, DEFAULT_ASSIST_SLUG[surface]].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    ),
  )];

  for (const slug of candidates) {
    const [row] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, slug), eq(agents.enabled, true)))
      .limit(1);
    if (row) return row.slug;
  }
  return null;
}
