import { NextResponse } from '@/server/http-compat';
import { resolveSingleOwnerId } from '@mantle/db';
import { loadProfilePreferences, logoVersion } from '@mantle/content';

/**
 * GET /api/appearance — the brain's SYSTEM-WIDE appearance: colour theme, the
 * four fonts and their sizes, the avatar style. Deliberately unauthenticated
 * (in PUBLIC_PATHS).
 *
 * Why public: the client app is a separate origin after the carve and is
 * zero-secret, so it cannot read prefs from the DB — but it must know the
 * theme BEFORE first paint or every visitor gets a flash of the default theme
 * on a browser that has never stored the localStorage cache (which, on a
 * freshly migrated box, is everyone). client/web's blocking /env.js fetches
 * this server-side and stamps it into the document. Nothing here is sensitive:
 * it is the same branding any share link already renders publicly.
 *
 * It also carries the brain's IDENTITY — `siteName`, `peerName`, and whether a
 * logo has been uploaded. That is a deliberate widening, made 2026-08-21: the
 * sign-in screen has to know what brain it belongs to, and it runs before there
 * is a session to call the authenticated /api/shell with. A brain must be able
 * to say what it is before it asks who you are. Across a fleet of brains on
 * their own domains that is the difference between an identifiable login screen
 * and several identical ones — and it is the same branding a public share link
 * already renders, so it crosses no line this route had not already crossed.
 *
 * Only the logo's VERSION travels, never a key or a path: the bytes were always
 * public at /api/appearance/logo, and what the caller gains is the knowledge
 * that an upload exists. No other preference joins them — this stays branding.
 *
 * Cached briefly — this is on the critical path of every full page load, and
 * branding changes seldom. An admin's change shows up within the window.
 */
export async function GET() {
  // Same SHAPE as the populated branch, always: a fresh install differs in its
  // values, never in its keys, so a client cannot come to depend on a field
  // that only appears once the brain is provisioned.
  const empty = {
    siteName: null,
    peerName: null,
    logoVersion: null,
    logoDarkVersion: null,
    colorTheme: null,
    fontLogo: null,
    fontTitle: null,
    fontUi: null,
    fontProse: null,
    fontSize: null,
    fontLogoSize: null,
    fontTitleSize: null,
    fontProseSize: null,
    avatarStyle: null,
    avatarTint: null,
    backgrounds: null,
    neatBackground: null,
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
        // Identity — see the header. These are BRAIN preferences (resolved to
        // the anchor row by loadProfilePreferences), so every admin sees the
        // one brand rather than their own.
        siteName: prefs.siteName ?? null,
        peerName: prefs.peerName ?? null,
        // Presence + cache-busting version only; the bytes are already public.
        logoVersion: logoVersion(prefs.logoKey),
        logoDarkVersion: logoVersion(prefs.logoDarkKey),
        colorTheme: prefs.colorTheme ?? null,
        fontLogo: prefs.fontLogo ?? null,
        fontTitle: prefs.fontTitle ?? null,
        fontUi: prefs.fontUi ?? null,
        fontProse: prefs.fontProse ?? null,
        fontSize: prefs.fontSize ?? null,
        fontLogoSize: prefs.fontLogoSize ?? null,
        fontTitleSize: prefs.fontTitleSize ?? null,
        fontProseSize: prefs.fontProseSize ?? null,
        avatarStyle: prefs.avatarStyle ?? null,
        avatarTint: prefs.avatarTint ?? null,
        backgrounds: prefs.backgrounds ?? null,
        neatBackground: prefs.neatBackground ?? null,
      },
      { headers },
    );
  } catch {
    // Never fail a page load over branding.
    return NextResponse.json(empty, { headers });
  }
}
