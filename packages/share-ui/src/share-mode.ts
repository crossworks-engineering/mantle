/**
 * The /s reader's visitor mode contract — deliberately its own tiny module:
 * the share-page browser runtime imports it, and routing it through
 * appearance.ts would drag the avatar/font/background registries into a
 * bundle that exists to stay small.
 */

/** The localStorage key holding a /s VISITOR's own light/dark choice — theirs
 *  alone, never the owner's. Two bundles must agree on it: the server's
 *  pre-paint inline script (template.ts) writes the reader, the share-page
 *  runtime writes the value. One constant, no mirrored literal. */
export const SHARE_MODE_STORAGE_KEY = 'mantle-share-mode';
