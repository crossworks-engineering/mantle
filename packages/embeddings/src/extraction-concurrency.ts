import { envNum, envNumDefault, envNumGiven, ENV_NUMBERS } from '@mantle/config';

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

/** Books at once, in the book lane (`mantle.extract.book`; docs/embeddings.md,
 *  the lanes): the saved `extraction_book_concurrency` (0393), then
 *  `EXTRACT_BOOK_CONCURRENCY`, then 1; 1 to 4. */
export const BOOK_CONCURRENCY_DEFAULT = envNumDefault('EXTRACT_BOOK_CONCURRENCY');
export const BOOK_CONCURRENCY_MAX = ENV_NUMBERS.EXTRACT_BOOK_CONCURRENCY.max;

/** Saved config value → `EXTRACT_BOOK_CONCURRENCY` env → default, clamped
 *  to 1..max, as resolveExtractionConcurrency. The column's CHECK holds a
 *  saved value to 1..4, so the clamp only meets a value from elsewhere. */
export function resolveBookConcurrency(saved?: number | null): number {
  if (saved == null) return envNum('EXTRACT_BOOK_CONCURRENCY');
  if (!Number.isFinite(saved) || saved < 1) return BOOK_CONCURRENCY_DEFAULT;
  return Math.min(Math.floor(saved), BOOK_CONCURRENCY_MAX);
}

/** The minutes one extraction may run before the queue expires it and tries
 *  again: the saved `extraction_time_budget_minutes`, then
 *  `MANTLE_EXTRACT_EXPIRE_MIN`, then 60. A book's budget grows from it with
 *  its pages (server/api extract-lanes.ts bookExpireMinutes). */
export const EXTRACTION_TIME_BUDGET_DEFAULT = envNumDefault('MANTLE_EXTRACT_EXPIRE_MIN');
/** The most a saved budget may be, in minutes (the settings form's bound). */
export const EXTRACTION_TIME_BUDGET_MAX = 720;

/** Saved config value (1 or more) → `MANTLE_EXTRACT_EXPIRE_MIN` env →
 *  default. A blank or zero saved value falls through to the env. */
export function resolveExtractionTimeBudget(saved?: number | null): number {
  if (saved != null && Number.isFinite(saved) && saved >= 1) return Math.floor(saved);
  return envNum('MANTLE_EXTRACT_EXPIRE_MIN');
}

/** Each lane setting's range, for a caller that checks a value before a
 *  save (the route, the MCP tool) or shows it. */
export const LANE_SETTING_RANGES = {
  concurrency: { min: 1, max: EXTRACTION_CONCURRENCY_MAX },
  bookConcurrency: { min: 1, max: BOOK_CONCURRENCY_MAX },
  timeBudgetMinutes: { min: 1, max: EXTRACTION_TIME_BUDGET_MAX },
} as const;

/** Where a lane setting in use comes from: the saved setting, the env file,
 *  or the code default. */
export type LaneSettingSource = 'saved' | 'env' | 'default';

/** The source of a lane setting, as its resolver above decides: `saved`
 *  when the row holds one it takes, else `env` when the env value counts,
 *  else `default`. A saved count under 1 (no writer saves one) is the
 *  default, as resolveExtractionConcurrency and resolveBookConcurrency take
 *  it; a saved budget under 1 falls through to the env, as
 *  resolveExtractionTimeBudget does. */
export function laneSettingSource(
  saved: number | null | undefined,
  envName: 'EXTRACT_CONCURRENCY' | 'EXTRACT_BOOK_CONCURRENCY' | 'MANTLE_EXTRACT_EXPIRE_MIN',
): LaneSettingSource {
  if (saved != null && Number.isFinite(saved) && saved >= 1) return 'saved';
  if (saved != null && envName !== 'MANTLE_EXTRACT_EXPIRE_MIN') return 'default';
  return envNumGiven(envName) ? 'env' : 'default';
}
