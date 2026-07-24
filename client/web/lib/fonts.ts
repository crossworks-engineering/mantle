import localFont from 'next/font/local';

/**
 * Global sans-serif UI font. Self-hosted Inter variable font from
 * `/public/Inter/` — no external font CDN dependency at runtime, which
 * matches Mantle's self-hosted ethos. `variable: "--font-sans"` wires it
 * into the Tailwind theme (see globals.css @theme inline) and is applied
 * on <body> in app/layout.tsx.
 */
export const fontSans = localFont({
  variable: '--font-sans',
  display: 'swap',
  // No <link rel=preload>: next/font preloads EVERY src entry, and the italic
  // face is rarely rendered within the window's load event, so preloading it
  // trips "preloaded but not used within a few seconds" on nearly every page.
  // next/font has no per-src preload toggle, and splitting normal/italic into two
  // localFont calls would break real italic (font-style:italic would fall back to
  // faux-synthesised slant). The faces are woff2 (~349KB/385KB, converted from
  // the .ttf with `woff2_compress` — brew install woff2), small enough that the
  // swap is quick without preload. Regenerate: woff2_compress on the upstream
  // Inter variable .ttf (rsms/inter), then drop the .woff2 into /public/Inter.
  preload: false,
  fallback: [
    'ui-sans-serif',
    'system-ui',
    '-apple-system',
    'BlinkMacSystemFont',
    'Segoe UI',
    'Roboto',
    'Helvetica Neue',
    'Arial',
    'Noto Sans',
    'sans-serif',
  ],
  src: [
    {
      path: '../public/Inter/Inter-VariableFont_opsz,wght.woff2',
      style: 'normal',
      weight: '100 900',
    },
    {
      path: '../public/Inter/Inter-Italic-VariableFont_opsz,wght.woff2',
      style: 'italic',
      weight: '100 900',
    },
  ],
});

/**
 * Display/logo font — used only for the "Mantle" wordmark. Self-hosted
 * Bukhari Script. Exposed as `--font-logo` (mapped to the `font-logo`
 * utility in globals.css @theme inline).
 */
export const fontLogo = localFont({
  variable: '--font-logo',
  display: 'swap',
  src: [
    {
      path: '../public/fonts/BukhariScript-Regular.ttf',
      style: 'normal',
      weight: '400',
    },
  ],
});
