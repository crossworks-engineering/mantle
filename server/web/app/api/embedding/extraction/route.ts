import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { sql, eq } from 'drizzle-orm';
import { db, embeddingConfig } from '@mantle/db';
import {
  clearEmbeddingModelCache,
  EXTRACTION_CONCURRENCY_DEFAULT,
  EXTRACTION_CONCURRENCY_MAX,
  resolveExtractionConcurrency,
} from '@mantle/embeddings';
import { getOwnerOr401 } from '@/lib/auth';
import { rowsOf } from '@/lib/integrity/sql-util';
import { notifyProviderRecover } from '@/lib/embedding-config';

type QueueRow = {
  running: number;
  waiting: number;
  retrying: number;
  done_10m: number;
  dead: number;
};

/** The extractor at a glance: how many workers it should run, and what its
 *  queue is doing now. The count is live: the extractor re-reads the saved
 *  value every 30s and grows or shrinks its pool, no restart. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [row] = await db
    .select({ saved: embeddingConfig.extractionConcurrency })
    .from(embeddingConfig)
    .where(eq(embeddingConfig.ownerId, user.id))
    .limit(1);
  const saved = row?.saved ?? null;
  const q = rowsOf<QueueRow>(
    await db.execute<QueueRow>(sql`
      SELECT
        count(*) FILTER (WHERE name = 'mantle.extract' AND state = 'active')::int AS running,
        count(*) FILTER (WHERE name = 'mantle.extract' AND state = 'created')::int AS waiting,
        count(*) FILTER (WHERE name = 'mantle.extract' AND state = 'retry')::int AS retrying,
        count(*) FILTER (WHERE name = 'mantle.extract' AND state = 'completed'
                           AND completed_on > now() - interval '10 minutes')::int AS done_10m,
        count(*) FILTER (WHERE name = 'mantle.extract.dead' AND state = 'created')::int AS dead
      FROM pgboss.job
      WHERE name IN ('mantle.extract', 'mantle.extract.dead')`),
  )[0];
  return NextResponse.json({
    concurrency: {
      saved,
      effective: resolveExtractionConcurrency(saved),
      default: EXTRACTION_CONCURRENCY_DEFAULT,
      max: EXTRACTION_CONCURRENCY_MAX,
    },
    queue: {
      running: q?.running ?? 0,
      waiting: q?.waiting ?? 0,
      retrying: q?.retrying ?? 0,
      doneLast10Min: q?.done_10m ?? 0,
      deadLettered: q?.dead ?? 0,
    },
  });
}

const Body = z.object({
  concurrency: z.number().int().min(1).max(EXTRACTION_CONCURRENCY_MAX).nullable(),
});

/** Set only the extractor count (null = back to the default). The rest of the
 *  embedder config is left alone. */
export async function PATCH(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: `concurrency must be 1 to ${EXTRACTION_CONCURRENCY_MAX}, or null` },
      { status: 400 },
    );
  }
  const updated = await db
    .update(embeddingConfig)
    .set({ extractionConcurrency: parsed.data.concurrency, updatedAt: new Date() })
    .where(eq(embeddingConfig.ownerId, user.id))
    .returning({ ownerId: embeddingConfig.ownerId });
  if (updated.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'Set up the embedder first (Settings, Embedding).' },
      { status: 409 },
    );
  }
  clearEmbeddingModelCache(user.id);
  // A save is a reason to try again: the agent probes an open alert and
  // recovers a waiting backlog (docs/embeddings.md "Provider outages").
  await notifyProviderRecover(user.id);
  return NextResponse.json({
    ok: true,
    saved: parsed.data.concurrency,
    effective: resolveExtractionConcurrency(parsed.data.concurrency),
  });
}
