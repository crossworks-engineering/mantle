// The running build's identity. Values are injected at compile time by
// next.config.ts (NEXT_PUBLIC_* → inlined by Next), so this module is safe to
// import from both client and server components and carries no runtime cost.
//
// Source of truth for the version is the ROOT package.json — bump it with
// `pnpm version:bump <patch|minor|major|x.y.z>` (see docs/versioning.md).
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';
export const GIT_SHA = process.env.NEXT_PUBLIC_GIT_SHA ?? '';
export const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME ?? '';

/** Short label shown next to the wordmark, e.g. "v0.19.0-alpha". */
export const VERSION_LABEL = `v${APP_VERSION}`;

/** localStorage key holding the last APP_VERSION whose changelog was viewed —
 *  drives the sidebar "What's new?" pill (cleared by visiting /changelog). */
export const CHANGELOG_LAST_SEEN_VERSION_KEY = 'mantle_changelog_last_seen_version';

/** Window event fired after /changelog stamps the key, so the sidebar pill
 *  clears immediately (client-side nav doesn't remount the shell). */
export const CHANGELOG_SEEN_EVENT = 'mantle:changelog-seen';

/**
 * Full build identity for tooltips / ops, e.g.
 * "v0.19.0-alpha · 5a96bcd · 2026-06-05".
 * SHA and date are omitted when not available (e.g. a local `next dev` with no
 * git, or a build that didn't stamp the time).
 */
export function versionDetail(): string {
  const parts = [VERSION_LABEL];
  if (GIT_SHA) parts.push(GIT_SHA);
  if (BUILD_TIME) parts.push(BUILD_TIME.slice(0, 10));
  return parts.join(' · ');
}

/**
 * The WIRE-CONTRACT version — the client/server compatibility handshake for
 * the jackdaw repo split (plan P1/P3, docs/plans/jackdaw-repo-split.md).
 *
 * Bump this integer ONLY when the HTTP API or a shared DTO shape changes in a
 * way an older client cannot tolerate (removed/renamed fields, changed
 * semantics). Additive changes do NOT bump it. Distinct from APP_VERSION: the
 * app version keeps moving with every release on both sides of the split,
 * while this only moves on breaking wire changes.
 *
 * Served by the server at /api/version (`contractVersion`); after P3 the
 * client compares it against its own supported value and shows a
 * "server too old / too new" banner instead of failing obscurely.
 */
export const CONTRACT_VERSION = 1;

/**
 * The pinned @excalidraw/excalidraw version, stamped onto every stored draw
 * snapshot so an upgrade can mark old renders stale. A LITERAL because the
 * package's exports map hides its own package.json. Tripwires on BOTH sides
 * of the repo split assert their local pin equals this: mantle's
 * server/web/lib/excalidraw-engine.test.ts and jackdaw's client/web mirror.
 */
export const EXCALIDRAW_ENGINE = '0.18.1';
