import { NextResponse } from 'next/server';
import { desc, eq, sql } from 'drizzle-orm';
import { db, runItems, runs } from '@mantle/db';
import { isRunsEnabled } from '@mantle/runs';
import { getOwnerOr401 } from '@/lib/auth';

/** GET /api/debug/runs — recent runs (newest first) + the feature-gate state. */
const LIMIT = 50;

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const rows = await db
    .select({
      id: runs.id,
      title: runs.title,
      status: runs.status,
      createdAt: runs.createdAt,
      completedAt: runs.completedAt,
      costMicroUsd: sql<string>`coalesce((select sum(${runItems.costMicroUsd}) from ${runItems} where ${runItems.runId} = ${runs.id}), 0)`,
      itemCount: sql<number>`(select count(*) from ${runItems} where ${runItems.runId} = ${runs.id})::int`,
    })
    .from(runs)
    .where(eq(runs.ownerId, user.id))
    .orderBy(desc(runs.createdAt))
    .limit(LIMIT);
  return NextResponse.json({
    enabled: isRunsEnabled(),
    runs: rows.map((r) => ({ ...r, costMicroUsd: Number(r.costMicroUsd) })),
  });
}
