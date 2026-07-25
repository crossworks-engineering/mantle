import { displayFontFaceCss } from '@mantle/web-ui/display-fonts';
import type { AppearanceAttrs } from '@mantle/web-ui/appearance';

/**
 * HTML shells for the server-rendered surfaces (/s, /print, stubs) — the
 * hand-rolled replacement for app/layout.tsx + app/s/layout.tsx now that Next
 * no longer renders here. Styling comes from the prebuild-compiled Tailwind
 * bundle (scripts/build-share-runtime.ts → /share-runtime/styles.css), so
 * these pages keep the exact app theme (tokens, ~40 palettes, editor CSS).
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON safe to embed inside a <script> block or attribute (no `</script>`
 *  breakout, no U+2028/2029 parse errors). */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Replacement for the next/font(lib/fonts.ts) output: the same self-hosted
 *  faces declared by hand, wired to the theme vars (--font-sans/--font-logo)
 *  that themes.css maps onto the font-sans/font-logo utilities. */
const FONT_CSS = `
@font-face{font-family:'InterVariable';font-style:normal;font-weight:100 900;font-display:swap;src:url('/Inter/Inter-VariableFont_opsz,wght.woff2') format('woff2')}
@font-face{font-family:'InterVariable';font-style:italic;font-weight:100 900;font-display:swap;src:url('/Inter/Inter-Italic-VariableFont_opsz,wght.woff2') format('woff2')}
@font-face{font-family:'Bukhari Script';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/BukhariScript-Regular.ttf') format('truetype')}
:root{--font-sans:'InterVariable',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif;--font-logo:'Bukhari Script'}
`.trim();

export type PageMeta = {
  title: string;
  description?: string;
  /** OG/Twitter unfurl tags (share surface). */
  og?: { title: string; description: string };
  /** `noindex, nofollow` robots tag (share surface). */
  noindex?: boolean;
  /** Extra raw HTML appended to <head> (surface-specific inline styles). */
  extraHead?: string;
  /** Load /share-runtime/islands.js at the end of <body>. */
  islands?: boolean;
  /**
   * The brain OWNER's appearance, rendered as attributes + inline style on the
   * `<html>` tag (see @mantle/web-ui/appearance). These are BRANDED surfaces:
   * the owner's theme is the only theme — there is no visitor-localStorage
   * layer here — and `data-color-theme-owner` locks the client providers in
   * any mounted island (AppSandbox, table) from re-deriving over it.
   * Omitted (stubs, prefs unreadable) ⇒ default theme + fonts.
   */
  appearance?: AppearanceAttrs;
};

/** The <html> attribute string for a surface's appearance. Values are
 *  registry/projection-validated slugs, but escape anyway — attributes are an
 *  injection surface and this must stay safe by construction. */
function htmlAttrs(a: AppearanceAttrs | undefined): string {
  if (!a) return '';
  const parts: string[] = [];
  if (a.colorTheme) parts.push(`data-color-theme="${escapeHtml(a.colorTheme)}"`);
  if (a.fontLogo) parts.push(`data-font-logo="${escapeHtml(a.fontLogo)}"`);
  if (a.fontTitle) parts.push(`data-font-title="${escapeHtml(a.fontTitle)}"`);
  const vars: string[] = [];
  if (a.fontVars.wordmark) vars.push(`--font-wordmark:${a.fontVars.wordmark}`);
  if (a.fontVars.pageTitle) vars.push(`--font-page-title:${a.fontVars.pageTitle}`);
  if (vars.length) parts.push(`style="${escapeHtml(vars.join(';'))}"`);
  // The lock rides along even when everything is default: an owner surface is
  // owner-branded regardless, and the lock is what stops a mounted island's
  // provider from applying visitor-local state (e.g. the random-theme toggle)
  // over it.
  return [' data-color-theme-owner="1"', ...parts].join(' ');
}

export function htmlPage(meta: PageMeta, bodyHtml: string): string {
  const head = [
    `<meta charset="utf-8"/>`,
    `<meta name="viewport" content="width=device-width, initial-scale=1"/>`,
    `<title>${escapeHtml(meta.title)}</title>`,
    meta.description ? `<meta name="description" content="${escapeHtml(meta.description)}"/>` : '',
    meta.noindex ? `<meta name="robots" content="noindex, nofollow"/>` : '',
    meta.og
      ? [
          `<meta property="og:title" content="${escapeHtml(meta.og.title)}"/>`,
          `<meta property="og:description" content="${escapeHtml(meta.og.description)}"/>`,
          `<meta property="og:type" content="article"/>`,
          `<meta name="twitter:card" content="summary"/>`,
          `<meta name="twitter:title" content="${escapeHtml(meta.og.title)}"/>`,
          `<meta name="twitter:description" content="${escapeHtml(meta.og.description)}"/>`,
        ].join('')
      : '',
    `<link rel="icon" href="/favicon.ico" sizes="48x48"/>`,
    `<link rel="icon" href="/icon.svg" type="image/svg+xml"/>`,
    `<link rel="apple-touch-icon" href="/apple-icon.png"/>`,
    `<link rel="stylesheet" href="/share-runtime/styles.css"/>`,
    `<link rel="stylesheet" href="/share-runtime/katex/katex.min.css"/>`,
    // AFTER the compiled stylesheet: themes.css declares a fallback
    // `--font-sans` on :root, and the self-hosted @font-face override must win
    // the cascade (same specificity ⇒ source order decides).
    `<style>${FONT_CSS}</style>`,
    // Selectable wordmark/title fonts: @font-face declarations (lazy — a file
    // downloads only when a face is actually painted). The CHOSEN faces render
    // as <html> attributes/inline style via meta.appearance, not a script.
    `<style>${displayFontFaceCss()}</style>`,
    meta.extraHead ?? '',
  ]
    .filter(Boolean)
    .join('\n');

  const islands = meta.islands
    ? `<script type="module" src="/share-runtime/islands.js"></script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en" class="h-full"${htmlAttrs(meta.appearance)}>
<head>
${head}
</head>
<body class="h-full font-sans antialiased">
${bodyHtml}
${islands}
</body>
</html>`;
}

/** The /s share shell (was app/s/layout.tsx): clean centered surface, quiet
 *  footer, its own scroll container (globals.css pins html/body overflow). */
export function shareShell(inner: string): string {
  return `<div class="flex h-dvh flex-col overflow-y-auto scrollbar-thin bg-background text-foreground">
<main class="flex-1">${inner}</main>
<footer class="border-t border-border/60 py-6"><p class="text-center text-xs text-muted-foreground">Shared via <span class="font-logo lowercase">mantle</span></p></footer>
</div>`;
}

/** Mount point for a client island (server/islands/entry.tsx mounts these). */
export function islandDiv(kind: string, props: Record<string, unknown>, className = ''): string {
  return `<div data-island="${escapeHtml(kind)}" data-props="${escapeHtml(
    scriptSafeJson(props),
  )}"${className ? ` class="${escapeHtml(className)}"` : ''}></div>`;
}
