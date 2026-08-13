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
  // faux-synthesised slant). The faces are woff2 (~349KB/385KB), small enough
  // that the swap is quick without preload. To refresh: download the upstream
  // Inter variable .ttf (rsms/inter), run `node scripts/fonts-to-woff2.mjs
  // --prune <file>`, drop the .woff2 into /public/Inter. No system toolchain
  // needed — the script encodes with wasm, so no `brew install woff2`.
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

/*
 * There is no second next/font face any more. The wordmark used to be a
 * separate always-loaded Bukhari Script here; it is now just another entry in
 * the font library (@mantle/web-ui/display-fonts), declared in the shared
 * `@font-face` block and fetched lazily like every other selectable face. Its
 * default lives in one place, `--font-brand` in app.css, which is also what the
 * product mark in the footer reads.
 *
 * Inter stays here because it is the one face that is ALWAYS painted, which is
 * exactly the case next/font is right for.
 */
