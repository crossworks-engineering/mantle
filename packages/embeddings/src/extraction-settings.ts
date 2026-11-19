/**
 * The extractor's lane settings (docs/embeddings.md, the lanes): extractions at
 * once, books at once and the time budget, read and saved in one place for
 * GET and PATCH /api/embedding/extraction and the MCP tools extraction_get
 * and extraction_set (admin settings are never screen-only). Each is a
 * nullable column of the one embedding_config row (0099, 0391): null falls
 * back to its env value, then the code default. The extractor re-reads them
 * every 30 s (server/api extract-queue.ts reconcileWithConfig), so a save is
 * live with no restart.
 *
 * Values only: no model, route, key or base URL is read or written here.
 */
import { eq } from 'drizzle-orm';
import { db, embeddingConfig, onFullSystemRoute } from '@mantle/db';
import {
  BOOK_CONCURRENCY_DEFAULT,
  EXTRACTION_CONCURRENCY_DEFAULT,
  EXTRACTION_TIME_BUDGET_DEFAULT,
  LANE_SETTING_RANGES,
  laneSettingSource,
  resolveBookConcurrency,
  resolveExtractionConcurrency,
  resolveExtractionTimeBudget,
  type LaneSettingSource,
} from './extraction-concurrency';

/** One lane setting as a settings screen and a tool show it. */
export type LaneSetting = {
  /** The saved value, or null (the env value, then the default). */
  saved: number | null;
  /** The value the extractor runs with now. */
  effective: number;
  /** Where `effective` comes from. */
  source: LaneSettingSource;
  default: number;
  min: number;
  max: number;
};

export type ExtractionLaneSettings = {
  /** False when the brain has no embedding_config row yet: nothing can be
   *  saved until the embedder is set up (Settings, Embedding). */
  configured: boolean;
  /** Extractions at once: light and heavy files together. */
  concurrency: LaneSetting;
  /** Books at once, in the book lane, beside the count above. */
  book_concurrency: LaneSetting;
  /** Minutes one extraction may run (a book's grows with its pages). */
  time_budget_minutes: LaneSetting;
};

/** A change: a number sets the value, null clears it (back to the env value,
 *  then the default), absent leaves it. */
export type ExtractionLanePatch = {
  concurrency?: number | null;
  bookConcurrency?: number | null;
  timeBudgetMinutes?: number | null;
};

/** The settings as they stand: saved, in use, and where each comes from. */
export async function readExtractionLaneSettings(ownerId: string): Promise<ExtractionLaneSettings> {
  const [row] = await db
    .select({
      concurrency: embeddingConfig.extractionConcurrency,
      book: embeddingConfig.extractionBookConcurrency,
      budget: embeddingConfig.extractionTimeBudgetMinutes,
    })
    .from(embeddingConfig)
    .where(eq(embeddingConfig.ownerId, ownerId))
    .limit(1);
  const concurrency = row?.concurrency ?? null;
  const book = row?.book ?? null;
  const budget = row?.budget ?? null;
  return {
    configured: row !== undefined,
    concurrency: {
      saved: concurrency,
      effective: resolveExtractionConcurrency(concurrency),
      source: laneSettingSource(concurrency, 'EXTRACT_CONCURRENCY'),
      default: EXTRACTION_CONCURRENCY_DEFAULT,
      ...LANE_SETTING_RANGES.concurrency,
    },
    book_concurrency: {
      saved: book,
      effective: resolveBookConcurrency(book),
      source: laneSettingSource(book, 'EXTRACT_BOOK_CONCURRENCY'),
      default: BOOK_CONCURRENCY_DEFAULT,
      ...LANE_SETTING_RANGES.bookConcurrency,
    },
    time_budget_minutes: {
      saved: budget,
      effective: resolveExtractionTimeBudget(budget),
      source: laneSettingSource(budget, 'MANTLE_EXTRACT_EXPIRE_MIN'),
      default: EXTRACTION_TIME_BUDGET_DEFAULT,
      ...LANE_SETTING_RANGES.timeBudgetMinutes,
    },
  };
}

/** The name of each setting in a body and a tool's input. */
const LANE_LABELS: Record<keyof ExtractionLanePatch, string> = {
  concurrency: 'concurrency',
  bookConcurrency: 'book_concurrency',
  timeBudgetMinutes: 'time_budget_minutes',
};

/** Why a change cannot be saved, or null when it can: nothing to change, or
 *  a value that is not a whole number in its range (null is always fine). */
export function lanePatchProblem(patch: ExtractionLanePatch): string | null {
  const keys = (Object.keys(LANE_SETTING_RANGES) as (keyof ExtractionLanePatch)[]).filter(
    (k) => patch[k] !== undefined,
  );
  if (keys.length === 0)
    return 'nothing to change: give concurrency, book_concurrency or time_budget_minutes';
  for (const k of keys) {
    const v = patch[k];
    if (v === null) continue;
    const { min, max } = LANE_SETTING_RANGES[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      return `${LANE_LABELS[k]} must be a whole number ${min} to ${max}, or null`;
    }
  }
  return null;
}

/**
 * Save a change (checked first: lanePatchProblem). False when the brain has
 * no embedding_config row: set up the embedder first. The caller clears the
 * embedder cache of its own process if it reads the row through the
 * resolver; the extractor re-reads on its next tick.
 */
export async function saveExtractionLanePatch(
  ownerId: string,
  patch: ExtractionLanePatch,
): Promise<boolean> {
  const problem = lanePatchProblem(patch);
  if (problem) throw new RangeError(problem);
  const set: Partial<typeof embeddingConfig.$inferInsert> = { updatedAt: new Date() };
  if (patch.concurrency !== undefined) set.extractionConcurrency = patch.concurrency;
  if (patch.bookConcurrency !== undefined) set.extractionBookConcurrency = patch.bookConcurrency;
  if (patch.timeBudgetMinutes !== undefined) {
    set.extractionTimeBudgetMinutes = patch.timeBudgetMinutes;
  }
  // The lane settings (the spend rate of every extract) are not the narrow
  // login's (the destination and cost class, access-matrix.ts): the
  // full-route spot model-route.
  const updated = await onFullSystemRoute('model-route', () =>
    db
      .update(embeddingConfig)
      .set(set)
      .where(eq(embeddingConfig.ownerId, ownerId))
      .returning({ ownerId: embeddingConfig.ownerId }),
  );
  return updated.length > 0;
}
