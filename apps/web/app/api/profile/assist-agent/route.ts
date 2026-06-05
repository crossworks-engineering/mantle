/**
 * POST /api/profile/assist-agent — set which agent the editor "Assist" panel on
 * a given surface (`pages` | `tables`) delegates to. Backs the agent picker that
 * lives in the /pages and /tables Assist panels. Persists to
 * profiles.preferences.{pagesAssistAgentSlug,tablesAssistAgentSlug}.
 *
 * Body: { surface: 'pages' | 'tables', agentSlug: string | null }
 *   - agentSlug null/'' clears the override → the route falls back to the
 *     default specialist slug for that surface.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { loadProfilePreferences, updateProfilePreferences } from '@mantle/content';
import { DEFAULT_ASSIST_SLUG } from '@/lib/assist-agent';

/** Current Assist-panel agent overrides for both surfaces + the defaults the
 *  routes fall back to. Lets the in-panel picker render its current selection
 *  without threading prefs through the page server components. */
export async function GET() {
  const user = await requireOwner();
  const prefs = await loadProfilePreferences(user.id);
  return NextResponse.json({
    pages: prefs.pagesAssistAgentSlug ?? null,
    tables: prefs.tablesAssistAgentSlug ?? null,
    defaults: DEFAULT_ASSIST_SLUG,
  });
}

const Body = z.object({
  surface: z.enum(['pages', 'tables']),
  agentSlug: z.string().min(1).max(120).nullable(),
});

export async function POST(req: Request) {
  const user = await requireOwner();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const { surface, agentSlug } = parsed.data;
  // Empty string is treated as "clear" by loadProfilePreferences (length check),
  // so storing '' is a safe way to reset to the default.
  const value = agentSlug ?? '';
  const key = surface === 'pages' ? 'pagesAssistAgentSlug' : 'tablesAssistAgentSlug';
  const prefs = await updateProfilePreferences(user.id, { [key]: value });
  return NextResponse.json({
    ok: true,
    agentSlug: surface === 'pages' ? prefs.pagesAssistAgentSlug ?? null : prefs.tablesAssistAgentSlug ?? null,
  });
}
