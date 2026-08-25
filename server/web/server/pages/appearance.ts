import { loadProfilePreferences, projectDefaultMode } from '@mantle/content';
import { resolveAppearanceAttrs, type AppearanceAttrs } from '@mantle/share-ui/appearance';
import { decodeNeatSpec, encodeNeatSpec } from '@mantle/share-ui/neat-background';

/**
 * The brain's stored appearance — colour theme, the four fonts and their sizes,
 * the avatar style — as `<html>` attributes for htmlPage(), resolved
 * server-side from the anchor owner's preferences.
 *
 * The PROSE font matters most here: /print is what headless Chromium renders a
 * page's PDF from, so this is the path by which "set my Pages in Playfair"
 * reaches an exported document.
 *
 * These settings are SYSTEM-WIDE (one profile row on the anchor owner — see
 * the /api/profile/color-theme + /api/profile/fonts writers), and the share/
 * print surfaces are the brain's BRAND: the values render straight into the
 * document, the only delivery path (no scripts, no localStorage — see
 * @mantle/web-ui/appearance).
 *
 * Fails soft: if prefs can't be read the surface renders in the defaults
 * (undefined ⇒ htmlPage omits the attributes) rather than failing the page.
 */
export async function loadAppearanceAttrs(ownerId: string): Promise<AppearanceAttrs | undefined> {
  try {
    const prefs = await loadProfilePreferences(ownerId);
    return resolveAppearanceAttrs({
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
    });
  } catch {
    // prefs unavailable — fall back to the defaults rather than failing
    return undefined;
  }
}

/** What the /s share surface needs beyond the `<html>` attributes: the owner's
 *  default light/dark mode and the saved Neat gradient spec. */
export type ShareAppearance = {
  attrs: AppearanceAttrs | undefined;
  /** 'light' | 'dark' | 'system' — unset stores read as 'light', the share
   *  surface's historical rendering. */
  defaultMode: 'light' | 'dark' | 'system';
  /** The saved Neat spec in its canonical encoding, or null when no background
   *  is set (or the stored value doesn't decode) — null means the plain themed
   *  fill, exactly like the app surfaces. */
  neatBackground: string | null;
};

/**
 * The share surface's full appearance in one prefs read — the attrs (same
 * projection as loadAppearanceAttrs), the owner's default mode, and the Neat
 * background spec. Same fail-soft contract: unreadable prefs render the
 * defaults, never an error page.
 */
export async function loadShareAppearance(ownerId: string): Promise<ShareAppearance> {
  try {
    const prefs = await loadProfilePreferences(ownerId);
    const spec = decodeNeatSpec(prefs.neatBackground);
    return {
      attrs: resolveAppearanceAttrs({
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
      }),
      defaultMode: projectDefaultMode(prefs.defaultMode) ?? 'light',
      // Re-encoded, not passed raw: what reaches the document is always the
      // canonical form of a spec that actually decodes. The shareNeat switch
      // gates it here so OFF renders the plain, printable surface with no
      // trace of the gradient in the document at all.
      neatBackground: spec && prefs.shareNeat !== false ? encodeNeatSpec(spec) : null,
    };
  } catch {
    // prefs unavailable — fall back to the defaults rather than failing
    return { attrs: undefined, defaultMode: 'light', neatBackground: null };
  }
}
