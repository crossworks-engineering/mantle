import { envNum, envNumDefault, ENV_NUMBERS } from '@mantle/config';

/** How many extractions may run at once. One place for the numbers, so the
 *  extractor (server/api) and the settings API (server/web) agree. */
export const EXTRACTION_CONCURRENCY_DEFAULT = envNumDefault('EXTRACT_CONCURRENCY');
export const EXTRACTION_CONCURRENCY_MAX = ENV_NUMBERS.EXTRACT_CONCURRENCY.max;

/** Saved config value → `EXTRACT_CONCURRENCY` env → default, clamped to
 *  1..max. A blank, zero or junk value falls through to the default. */
export function resolveExtractionConcurrency(saved?: number | null): number {
  if (saved == null) return envNum('EXTRACT_CONCURRENCY');
  if (!Number.isFinite(saved) || saved < 1) return EXTRACTION_CONCURRENCY_DEFAULT;
  return Math.min(Math.floor(saved), EXTRACTION_CONCURRENCY_MAX);
}
