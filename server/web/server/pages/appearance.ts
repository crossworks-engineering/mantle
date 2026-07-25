import { loadProfilePreferences } from '@mantle/content';
import { DEFAULT_COLOR_THEME } from '@mantle/web-ui/lib/themes';
import { resolveFontVars } from '@mantle/web-ui/display-fonts';
import { scriptSafeJson } from './template';

/**
 * The brain's stored appearance — colour theme + the two display fonts — as a
 * `<head>` script, resolved server-side from the anchor owner's preferences.
 *
 * These settings are SYSTEM-WIDE: they live on the anchor owner's profile row
 * (see the /api/profile/color-theme + /api/profile/fonts writers), so one admin
 * choice brands every surface. The head-stamp path exists because the
 * localStorage before-paint cache the app uses cannot help here — an anonymous
 * share visitor has no stored copy, so without this a shared page or an
 * exported PDF renders in the default theme and default fonts instead of the
 * brain's brand.
 *
 * Emitted as a SCRIPT setting inline style props (not a `:root{}` rule), and
 * the caller places it in `extraHead`, after the localStorage prepaint scripts
 * in the base template: the font prepaint sets INLINE props, which beat any
 * stylesheet rule regardless of order, so the only way the owner's brand
 * reliably wins over a visitor's stale local cache is to set the same inline
 * props from a script that runs later.
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

  const stmts: string[] = [];

  // `colorThemeOwner` is the lock ColorThemeProvider checks on mount inside
  // sandboxed apps, so an embedded app doesn't re-apply a visitor's own theme
  // over the owner's brand. A default owner theme emits nothing — the
  // visitor's own preference (the template's localStorage script) stands.
  if (colorTheme && colorTheme !== DEFAULT_COLOR_THEME) {
    stmts.push(`d.dataset.colorTheme=${scriptSafeJson(colorTheme)};d.dataset.colorThemeOwner='1';`);
  }

  const fonts = resolveFontVars(fontLogo, fontTitle);
  if (fonts.wordmark) {
    stmts.push(`s.setProperty('--font-wordmark',${scriptSafeJson(fonts.wordmark)});`);
  }
  if (fonts.pageTitle) {
    stmts.push(`s.setProperty('--font-page-title',${scriptSafeJson(fonts.pageTitle)});`);
  }

  if (!stmts.length) return '';
  return `<script>(function(){try{var d=document.documentElement,s=d.style;${stmts.join(
    '',
  )}}catch(e){}})();</script>`;
}
