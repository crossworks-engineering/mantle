/**
 * POST /api/profile/assist-agent — set which agent the in-surface "Assist"
 * panel (`pages` | `tables` | `dev-tools`) delegates to. Backs the agent
 * picker in each panel. Persists to
 * profiles.preferences.{pages,tables,devTools}AssistAgentSlug.
 *
 * Body: { surface: 'pages' | 'tables' | 'dev-tools', agentSlug: string | null }
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
    'dev-tools': prefs.devToolsAssistAgentSlug ?? null,
    defaults: DEFAULT_ASSIST_SLUG,
  });
}

const Body = z.object({
  surface: z.enum(['pages', 'tables', 'dev-tools']),
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
  const key =
    surface === 'pages'
      ? 'pagesAssistAgentSlug'
      : surface === 'tables'
        ? 'tablesAssistAgentSlug'
        : 'devToolsAssistAgentSlug';
  const prefs = await updateProfilePreferences(user.id, { [key]: value });
  const current =
    surface === 'pages'
      ? prefs.pagesAssistAgentSlug
      : surface === 'tables'
        ? prefs.tablesAssistAgentSlug
        : prefs.devToolsAssistAgentSlug;
  return NextResponse.json({ ok: true, agentSlug: current ?? null });
}
