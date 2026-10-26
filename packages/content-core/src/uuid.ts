/**
 * @mantle/content-core · uuid
 *
 * The one UUID regex of this published package, as @mantle/std's UUID_RE
 * (either case): content-core takes no runtime dependency, so it keeps its
 * own copy, here only. app-nav, profile-projections and canvas-data read it.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
