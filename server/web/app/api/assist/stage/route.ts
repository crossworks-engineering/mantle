/**
 * GET /api/assist/stage?surface=<pages|tables|apps|dev-tools> — the surface's
 * specialist's current activity label, polled by its Assist panel (~1×/s) while
 * a run is in flight so the user sees what's happening ("Editing the page…",
 * "Building…", "Testing the API…") instead of a blind spinner.
 *
 * One shared route for all four surfaces: resolve the surface's Assist agent
 * (respecting the per-surface picker override) → read the live trace filtered by
 * that agent's slug so concurrent surfaces never cross-talk. Returns
 * `{ label: null }` when idle or between recognisable stages. Never touches the
 * run path — two read-only indexed single-row queries.
 */
import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { resolveAssistAgentSlug, type AssistSurface } from '@/lib/assist-agent';
import { currentSpecialistStage } from '@/lib/assist-stage';

export const dynamic = 'force-dynamic';

const SURFACES: readonly AssistSurface[] = ['pages', 'tables', 'apps', 'dev-tools'];

function isSurface(v: string | null): v is AssistSurface {
  return v !== null && (SURFACES as readonly string[]).includes(v);
}

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const surface = new URL(req.url).searchParams.get('surface');
  if (!isSurface(surface)) {
    return NextResponse.json({ error: 'unknown surface' }, { status: 400 });
  }
  const slug = await resolveAssistAgentSlug(user.id, surface);
  // No usable agent provisioned → nothing is running for this surface.
  const label = slug ? await currentSpecialistStage(user.id, slug) : null;
  return NextResponse.json({ label });
}
