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
 * FALSE through R1, which is schema and contract only: the columns and the
 * revision table exist, nothing reads or writes them, and the v1 compiler
 * still owns every row. R2 lands the write path and the owner routes and
 * flips this to true in the same release, which is what tells a jackdaw
 * carrying the v2 screen (R3) that it may use it. Until then jackdaw keeps
 * the v1 screen, which is the correct rendering of this brain.
 */
export const RECALL_V2 = false;

export type ShellFeatures = {
  recallV2: boolean;
};

/** The flags for the owner shell. One object, so adding a flag is one line. */
export function shellFeatures(): ShellFeatures {
  return { recallV2: RECALL_V2 };
}
