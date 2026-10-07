import { env } from '@mantle/config';

/** How many extractions may run at once. One place for the numbers, so the
 *  extractor (server/api) and the settings API (server/web) agree. */
export const EXTRACTION_CONCURRENCY_DEFAULT = 2;
export const EXTRACTION_CONCURRENCY_MAX = 16;

/** Saved config value → `EXTRACT_CONCURRENCY` env → default, clamped to
 *  1..max. A blank, zero or junk value falls through to the default. */
export function resolveExtractionConcurrency(saved?: number | null): number {
  const envN = Number.parseInt(env('EXTRACT_CONCURRENCY') ?? '', 10);
  const candidate = saved != null ? saved : envN;
  if (!Number.isFinite(candidate) || candidate < 1) return EXTRACTION_CONCURRENCY_DEFAULT;
  return Math.min(Math.floor(candidate), EXTRACTION_CONCURRENCY_MAX);
}
