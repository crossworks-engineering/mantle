/**
 * The app bundler's safety rules a build was made under: the import gate,
 * the computed-import check and the library allowlist (@mantle/app-build).
 * A change to those checks raises APP_BUILD_RULES, so a bundle made before
 * it does not go live again as it was: a snapshot's full restore puts its
 * code in the draft instead, to be built under today's checks.
 */
export const APP_BUILD_RULES = 1;

/** Builds from before a build recorded its rules: made after every box ran a
 *  release with rules 1 (v0.400.x: tagged 2026-10-24, on all boxes by
 *  2026-10-26), so they count as rules 1. */
const RULES_1_SINCE = Date.parse('2026-10-27T00:00:00Z');

/** The build was made under today's rules. */
export function buildMeetsRules(build: { builtAt: string; rules?: number }): boolean {
  if (typeof build.rules === 'number') return build.rules >= APP_BUILD_RULES;
  const at = Date.parse(build.builtAt);
  return APP_BUILD_RULES === 1 && Number.isFinite(at) && at >= RULES_1_SINCE;
}
