import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import {
  refreshModelCatalog,
  contextLimitMap,
  contextLimitsFetchedAt,
  pricingMap,
} from '@mantle/tracing';

/**
 * Live model → catalog map, sourced from OpenRouter's public
 * `/api/v1/models` (cached + TTL-gated server-side, keyless) with a static
 * fallback for context windows. The agents form fetches this once to show
 * the context window AND pricing badges for whatever model slug the
 * operator picks — the same source the dashboard's context-% bars read,
 * so the number is consistent everywhere.
 *
 * Response shape (backward-compatible — `pricing` was added in Phase 2 of
 * the model-selection work; older clients reading only `limits` keep
 * working unchanged):
 *
 *     { limits: Record<slug, contextLength>,
 *       pricing: Record<slug, { inputPricePerM?, outputPricePerM? }>,
 *       fetchedAt: epoch | null }
 */
export async function GET() {
  const gate = await getOwnerOr401();
  if (gate instanceof Response) return gate;
  await refreshModelCatalog();
  return NextResponse.json({
    limits: contextLimitMap(),
    pricing: pricingMap(),
    fetchedAt: contextLimitsFetchedAt(),
  });
}
