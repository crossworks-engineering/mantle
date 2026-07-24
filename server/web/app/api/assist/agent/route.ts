/**
 * GET /api/assist/agent?surface=<pages|tables|apps|dev-tools> — the slug of the
 * specialist that surface's assist should talk to (respecting the per-surface
 * picker override, then the manifest default). The global assistant overlay
 * calls this when you open a Page / Table / App so it can pre-select the right
 * specialist (Pages / Ledger / Appsmith) without the user picking one.
 *
 * Mirror of /api/assist/stage's surface resolution — one read of the saved
 * preference + an enabled-agent existence check. Returns `{ agentSlug: null }`
 * when no usable specialist is provisioned, so the overlay just leaves the
 * sticky agent in place.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { resolveAssistAgentSlug, type AssistSurface } from '@/lib/assist-agent';


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
  const agentSlug = await resolveAssistAgentSlug(user.id, surface);
  return NextResponse.json({ agentSlug });
}
