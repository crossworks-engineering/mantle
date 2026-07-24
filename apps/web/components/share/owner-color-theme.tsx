import { loadProfilePreferences } from '@mantle/content';
import { DEFAULT_COLOR_THEME } from '@mantle/web-ui/lib/themes';

/**
 * Stamps the share OWNER's stored colour theme onto <html> for the public /s
 * surface, so shared pages/apps render in the brain's brand theme rather than
 * the visitor-browser default. A render-blocking inline script applies it
 * during parse (before hydration), overriding the root layout's localStorage
 * fast-path — which reflects the VISITOR's browser and is meaningless here.
 * Sandboxed apps mirror the host <html>, so they pick this up too. Unset,
 * default, or unreadable prefs ⇒ no stamp (the default theme).
 */
export async function OwnerColorTheme({ ownerId }: { ownerId: string }) {
  let theme: string | undefined;
  try {
    theme = (await loadProfilePreferences(ownerId)).colorTheme;
  } catch {
    // prefs unavailable — fall back to the default theme rather than failing
  }
  if (!theme || theme === DEFAULT_COLOR_THEME) return null;
  // colorThemeOwner is the lock ColorThemeProvider checks on mount — without
  // it, hydration re-applies the VISITOR's localStorage over this stamp.
  const js = `(function(h){h.dataset.colorTheme=${JSON.stringify(theme)};h.dataset.colorThemeOwner='1';})(document.documentElement);`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
