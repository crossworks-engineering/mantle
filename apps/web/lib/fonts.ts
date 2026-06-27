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
  // woff2 (not ttf): ~349KB/385KB vs ~875KB/905KB — small enough to load within
  // the window, so the earlier "preloaded but not used within a few seconds"
  // warning (a slow ~875KB .ttf finishing after the window's load event) is
  // resolved and preload can stay on. To regenerate: download the upstream Inter
  // variable .ttf (rsms/inter) and run `woff2_compress <file>.ttf` (brew install
  // woff2), then drop the .woff2 into /public/Inter.
  preload: true,
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
