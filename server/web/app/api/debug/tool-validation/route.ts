import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { resolveToolValidationMode } from '@mantle/runtime/agent';
import { toolValidationByTool, toolValidationRecent } from '@/lib/metrics';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** GET /api/debug/tool-validation — the central arg-validator's telemetry:
 *  per-tool flagged-call tallies + the most recent flagged calls in detail,
 *  plus this box's active mode (warn = telemetry only; enforce = violations
 *  block dispatch). `?days=` widens the window (default 7, max 90). */
export async function GET(req: Request) {
  const user = ownerCaller();
  const daysRaw = Number(new URL(req.url).searchParams.get('days'));
  const days = Number.isFinite(daysRaw) && daysRaw >= 1 ? Math.min(90, Math.floor(daysRaw)) : 7;
  const [byTool, recent] = await Promise.all([
    toolValidationByTool(user.id, days),
    toolValidationRecent(user.id, days),
  ]);
  return NextResponse.json({ mode: resolveToolValidationMode(), days, byTool, recent });
}
