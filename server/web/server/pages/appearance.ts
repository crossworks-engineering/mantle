import { loadProfilePreferences } from '@mantle/content';
import { resolveAppearanceAttrs, type AppearanceAttrs } from '@mantle/share-ui/appearance';

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
