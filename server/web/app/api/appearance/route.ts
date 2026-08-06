import { NextResponse } from '@/server/http-compat';
import { resolveSingleOwnerId } from '@mantle/db';
import { loadProfilePreferences } from '@mantle/content';

/**
 * GET /api/appearance — the brain's SYSTEM-WIDE appearance: colour theme, the
 * two display fonts and the avatar style. Deliberately unauthenticated (in PUBLIC_PATHS).
 *
 * Why public: the client app is a separate origin after the carve and is
 * zero-secret, so it cannot read prefs from the DB — but it must know the
 * theme BEFORE first paint or every visitor gets a flash of the default theme
 * on a browser that has never stored the localStorage cache (which, on a
 * freshly migrated box, is everyone). client/web's blocking /env.js fetches
 * this server-side and stamps it into the document. Nothing here is sensitive:
 * it is the same branding any share link already renders publicly.
 *
 * Cached briefly — this is on the critical path of every full page load, and
 * branding changes seldom. An admin's change shows up within the window.
 */
export async function GET() {
  const empty = {
    colorTheme: null,
    fontLogo: null,
    fontTitle: null,
    avatarStyle: null,
    avatarTint: null,
    fontUi: null,
    fontSize: null,
    backgrounds: null,
  };
  const headers = { 'Cache-Control': 'public, max-age=30' };

  // The whole body is fail-soft: resolveSingleOwnerId THROWS on a corrupt
  // no-anchor multi-user state (deliberately loud for workers), and a branding
  // endpoint must never turn that into a 500 — defaults, always.
  try {
    const ownerId = await resolveSingleOwnerId();
    // Fresh install, no account yet — defaults, not an error.
    if (!ownerId) return NextResponse.json(empty, { headers });
    const prefs = await loadProfilePreferences(ownerId);
    return NextResponse.json(
      {
        colorTheme: prefs.colorTheme ?? null,
        fontLogo: prefs.fontLogo ?? null,
        fontTitle: prefs.fontTitle ?? null,
        avatarStyle: prefs.avatarStyle ?? null,
        avatarTint: prefs.avatarTint ?? null,
        fontUi: prefs.fontUi ?? null,
        fontSize: prefs.fontSize ?? null,
        backgrounds: prefs.backgrounds ?? null,
      },
      { headers },
    );
  } catch {
    // Never fail a page load over branding.
    return NextResponse.json(empty, { headers });
  }
}
