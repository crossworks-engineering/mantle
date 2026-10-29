import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import {
  refreshModelCatalog,
  contextLimitMap,
  contextLimitsFetchedAt,
  pricingMap,
} from '@mantle/tracing';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/**
 * Live model → catalog map, sourced from OpenRouter's public
 * `/api/v1/models` (cached + TTL-gated server-side, keyless) with a static
 * fallback for context windows. The agents form fetches this once to show
 * the context window AND pricing badges for whatever model slug the
 * operator picks — the same source the dashboard's context-% bars read,
 * so the number is consistent everywhere.
 *
 * Response shape (backward-compatible: older clients reading only `limits`
 * keep working unchanged):
 *
 *     { limits: Record<slug, contextLength>,
 *       pricing: Record<slug, { inputPricePerM?, outputPricePerM? }>,
 *       fetchedAt: epoch | null }
 */
export async function GET() {
  ownerCaller();
  await refreshModelCatalog();
  return NextResponse.json({
    limits: contextLimitMap(),
    pricing: pricingMap(),
    fetchedAt: contextLimitsFetchedAt(),
  });
}
