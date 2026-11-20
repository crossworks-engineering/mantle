import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  clearEmbeddingModelCache,
  lanePatchProblem,
  readExtractionLaneSettings,
  saveExtractionLanePatch,
} from '@mantle/embeddings';
import { LANE_SETTING_RANGES } from '@mantle/embeddings/extraction-concurrency';
import { ownerCaller } from '@/lib/auth';
import { extractionQueueCountsOrNull } from '@/lib/extraction-queue';
import { notifyProviderRecover } from '@/lib/embedding-config';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  PATCH: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** The extractor at a glance: its lane settings (extractions at once, books
 *  at once, the time budget), each saved, in use and with its source
 *  (`saved`, `env` or `default`), and what its queue is doing now. The
 *  settings are live: the extractor re-reads them every 30s and grows or
 *  shrinks its pools, no restart. The MCP tool extraction_get reads the
 *  same (@mantle/embeddings extraction-settings.ts). */
export async function GET() {
  const user = ownerCaller();
  const settings = await readExtractionLaneSettings(user.id);
  return NextResponse.json({
    concurrency: settings.concurrency,
    book_concurrency: settings.book_concurrency,
    time_budget_minutes: settings.time_budget_minutes,
    queue: await extractionQueueCountsOrNull(),
  });
}

const { concurrency: C, bookConcurrency: B } = LANE_SETTING_RANGES;
const Body = z
  .object({
    concurrency: z.number().int().min(C.min).max(C.max).nullable().optional(),
    book_concurrency: z.number().int().min(B.min).max(B.max).nullable().optional(),
  })
  .refine((b) => b.concurrency !== undefined || b.book_concurrency !== undefined);

/** Set the extractor count, books at once, or both (null = back to the env
 *  value, then the default; absent = unchanged). The rest of the embedder
 *  config is left alone. */
export async function PATCH(req: Request) {
  const user = ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
  const patch = parsed.success
    ? { concurrency: parsed.data.concurrency, bookConcurrency: parsed.data.book_concurrency }
    : null;
  if (!patch || lanePatchProblem(patch)) {
    return NextResponse.json(
      {
        ok: false,
        error: `concurrency must be ${C.min} to ${C.max} and book_concurrency ${B.min} to ${B.max}, or null; give at least one`,
      },
      { status: 400 },
    );
  }
  const saved = await saveExtractionLanePatch(user.id, patch);
  if (!saved) {
    return NextResponse.json(
      { ok: false, error: 'Set up the embedder first (Settings, Embedding).' },
      { status: 409 },
    );
  }
  clearEmbeddingModelCache(user.id);
  // A save is a reason to try again: the agent probes an open alert and
  // recovers a waiting backlog (docs/embeddings.md "Provider outages"), and
  // applies the new counts at once rather than on its next 30 s tick.
  await notifyProviderRecover(user.id);
  const now = await readExtractionLaneSettings(user.id);
  return NextResponse.json({
    ok: true,
    saved: now.concurrency.saved,
    effective: now.concurrency.effective,
    concurrency: now.concurrency,
    book_concurrency: now.book_concurrency,
  });
}
