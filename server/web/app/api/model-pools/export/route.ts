import { NextResponse } from '@/server/http-compat';
import { asc, eq } from 'drizzle-orm';
import { db, curatedModels } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import type { CuratedTemplateEntry } from '@mantle/client-types/model-pools-data';

/**
 * Export the curated pools as the repo-shipped TEMPLATE. The curator drafts in
 * the DB (this brain); the durable template is
 * packages/client-types/src/model-pools-data.json, and the seeder reads it as
 * `CURATED_MODEL_POOLS` — a FLAT array of {@link CuratedTemplateEntry}.
 *
 * This route used to emit a different shape: pools nested as
 * `[{ pool, label, models: [...] }]`, with `position` dropped entirely. Pasting
 * that over the template produced a file the seeder could not read, and nothing
 * caught it because no test ever fed one to the other (audit 2026-09-02,
 * tier 3). It now emits exactly the template shape, so a re-curation is a file
 * swap: save `json` over model-pools-data.json and commit.
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const rows = await db
    .select()
    .from(curatedModels)
    .where(eq(curatedModels.ownerId, user.id))
    .orderBy(asc(curatedModels.pool), asc(curatedModels.position), asc(curatedModels.createdAt));

  const entries: CuratedTemplateEntry[] = rows.map((e) => ({
    pool: e.pool,
    position: e.position,
    name: e.name,
    vendor: e.vendor,
    routes: e.routes as CuratedTemplateEntry['routes'],
    pricing: e.pricing as CuratedTemplateEntry['pricing'],
    rating: e.rating,
    note: e.note,
  }));

  return NextResponse.json({ entries, json: `${JSON.stringify(entries, null, 2)}\n` });
}
