import { NextResponse } from 'next/server';

import { getOwnerOr401 } from '@/lib/auth';
import { resolveCapabilities } from '@/lib/integrity/capabilities';
import { listLanded } from '@/lib/integrity/landed';
import type { LandedReport } from '@/lib/integrity/types';

// Read-only live view of the real content you've added and its brain footprint.
// No writes, no fixtures — safe to poll and safe to leave mid-load.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  const limitNum = limitRaw ? Number(limitRaw) : NaN;
  const limit = Number.isFinite(limitNum) ? limitNum : undefined;
  const typesParam = url.searchParams.get('types');
  const types = typesParam ? typesParam.split(',').filter(Boolean) : undefined;

  const [items, capabilities] = await Promise.all([
    listLanded(user.id, { limit, types }),
    resolveCapabilities(user.id),
  ]);

  const report: LandedReport = {
    generatedAt: new Date().toISOString(),
    items,
    capabilities,
  };
  return NextResponse.json(report);
}
