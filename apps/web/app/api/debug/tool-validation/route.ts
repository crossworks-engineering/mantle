import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { resolveToolValidationMode } from '@mantle/agent-runtime';
import { toolValidationByTool, toolValidationRecent } from '@/lib/metrics';

/** GET /api/debug/tool-validation — the central arg-validator's telemetry:
 *  per-tool flagged-call tallies + the most recent flagged calls in detail,
 *  plus this box's active mode (warn = telemetry only; enforce = violations
 *  block dispatch). `?days=` widens the window (default 7, max 90). */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const daysRaw = Number(new URL(req.url).searchParams.get('days'));
  const days = Number.isFinite(daysRaw) && daysRaw >= 1 ? Math.min(90, Math.floor(daysRaw)) : 7;
  const [byTool, recent] = await Promise.all([
    toolValidationByTool(user.id, days),
    toolValidationRecent(user.id, days),
  ]);
  return NextResponse.json({ mode: resolveToolValidationMode(), days, byTool, recent });
}
