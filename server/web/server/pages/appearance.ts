import { loadProfilePreferences } from '@mantle/content';
import { DEFAULT_COLOR_THEME } from '@mantle/web-ui/lib/themes';
import { fontVarsCss } from '@mantle/web-ui/display-fonts';
import { scriptSafeJson } from './template';

/**
 * The brain's stored appearance — colour theme + the two display fonts — as
 * `<head>` HTML, resolved server-side from the owner's preferences.
 *
 * These settings are SYSTEM-WIDE: they live on the anchor owner's profile row
 * (see the /api/profile/color-theme + /api/profile/fonts writers), so one admin
 * choice brands every surface. The head-stamp path exists because the
 * localStorage before-paint cache the app uses cannot help here — an anonymous
 * share visitor has no stored copy, so without this a shared page or an
 * exported PDF renders in the default theme and default fonts instead of the
 * brain's brand.
 *
 * Fails soft: if prefs can't be read we return '' and the surface renders in
 * the defaults, rather than failing the page.
 */
export async function appearanceStamp(ownerId: string): Promise<string> {
  let colorTheme: string | undefined;
  let fontLogo: string | undefined;
  let fontTitle: string | undefined;
  try {
    const prefs = await loadProfilePreferences(ownerId);
    colorTheme = prefs.colorTheme;
    fontLogo = prefs.fontLogo;
    fontTitle = prefs.fontTitle;
  } catch {
    // prefs unavailable — fall back to the defaults rather than failing
    return '';
  }

  const out: string[] = [];

  // `colorThemeOwner` is the lock ColorThemeProvider checks on mount inside
  // sandboxed apps, so an embedded app doesn't re-apply a visitor's own theme
  // over the owner's brand.
  if (colorTheme && colorTheme !== DEFAULT_COLOR_THEME) {
    out.push(
      `<script>(function(h){h.dataset.colorTheme=${scriptSafeJson(
        colorTheme,
      )};h.dataset.colorThemeOwner='1';})(document.documentElement);</script>`,
    );
  }

  const css = fontVarsCss(fontLogo, fontTitle);
  if (css) out.push(`<style>${css}</style>`);

  return out.join('');
}
