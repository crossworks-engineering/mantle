/**
 * Capability flags the owner client reads once, from `GET /api/shell`.
 *
 * These exist because the client is a SEPARATE release (jackdaw) paired to a
 * brain image: a client newer than the brain must not render a screen whose
 * routes do not exist yet, and a client older than the brain must keep working
 * unchanged. A flag says "this brain can do X", so the client can branch on
 * capability instead of on a version number it would have to parse and compare.
 *
 * Read them as absent-means-false: an older brain sends no `features` object at
 * all, so `features?.recallV2` is the shape a client should test.
 */

/**
 * Recall v2: the native authoring path — a map is a `recall` node and its
 * cards are rows written directly, rather than a page tree compiled into the
 * serving tables. Plan: "PLAN: Recall v2, its own content type" (dev brain,
 * roadmap task 5d6ce06a).
 *
 * TRUE from R2: the serving tools understand native maps and the contract
 * shapes (@mantle/client-types) carry the v2 fields, so a client may build
 * the v2 screen against this brain.
 *
 * The eleven owner write routes exist, and `features.test.ts` fails if this
 * flag is true while any of them is missing from the route manifest, so the
 * flag cannot say more than the brain can do.
 *
 * It stays true for good. Since R5 this brain serves no page-built (v1) map
 * at all, and a client that reads the flag as false or absent falls back to
 * its v1 screen (or, from jackdaw's R5 release, a "needs an update" state),
 * which is wrong for this brain.
 */
export const RECALL_V2 = true;

export type ShellFeatures = {
  recallV2: boolean;
};

/** The flags for the owner shell. One object, so adding a flag is one line. */
export function shellFeatures(): ShellFeatures {
  return { recallV2: RECALL_V2 };
}
