/**
 * Request header the middleware sets (always overwriting the inbound value)
 * when the path is a team-MEMBER surface (/team, /hub — not /team-admin,
 * which is the owner's console). The root layout reads it to render the
 * `data-color-theme-owner` lock into the original HTML, so the providers see
 * the lock at mount — before the carve this ordering came from the server
 * layout, and stamping it from a post-fetch effect instead left a window
 * where visitor-local state (e.g. the random-theme toggle) could start up
 * over the brand. Shared as a constant so middleware and layout can't drift.
 */
export const MEMBER_SURFACE_HEADER = 'x-mantle-member-surface';
