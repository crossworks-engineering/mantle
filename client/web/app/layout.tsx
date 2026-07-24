import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';
// KaTeX styles for math nodes (inlineMath/blockMath) — bundled locally from the
// npm package (no CDN), matching the self-hosted ethos.
import 'katex/dist/katex.min.css';
import { fontSans, fontLogo } from '@/lib/fonts';
import { ThemeProvider } from '@mantle/web-ui/theme-provider';
import { ColorThemeProvider } from '@mantle/web-ui/color-theme-provider';
import { FontProvider } from '@mantle/web-ui/font-provider';
import { QueryProvider } from '@mantle/web-ui/query-provider';
import { COLOR_THEME_STORAGE_KEY, DEFAULT_COLOR_THEME } from '@mantle/web-ui/lib/themes';
import { displayFontFaceCss, fontPrepaintScript } from '@mantle/web-ui/display-fonts';

/**
 * ZERO-SECRET client root layout. No DB, no session read — the tab title is
 * the static default (the server app's logged-in metadata personalization
 * doesn't apply here; the shell adopts siteName client-side after /api/shell).
 */
export const metadata: Metadata = {
  title: 'Mantle',
  description: 'Your tree of everything.',
};

// Apply the stored color theme before paint to avoid a flash.
const colorThemeScript = `(function(){try{var t=localStorage.getItem('${COLOR_THEME_STORAGE_KEY}');if(t&&t!=='${DEFAULT_COLOR_THEME}'){document.documentElement.dataset.colorTheme=t;}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        {/* Runtime config FIRST and BLOCKING — window.__MANTLE_ENV__ (api base,
            flags) must exist before any bundle code runs. Served per-request by
            app/env.js/route.ts from process.env: one image, any server origin. */}
        <Script src="/env.js" strategy="beforeInteractive" />
        <script dangerouslySetInnerHTML={{ __html: colorThemeScript }} />
        {/* Selectable wordmark/title fonts: @font-face declarations (lazy — a
            file downloads only when a face is actually painted) + the before-paint
            var restore, mirroring the colour-theme script above. */}
        <style dangerouslySetInnerHTML={{ __html: displayFontFaceCss() }} />
        <script dangerouslySetInnerHTML={{ __html: fontPrepaintScript() }} />
      </head>
      <body className={`${fontSans.variable} ${fontLogo.variable} h-full font-sans antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ColorThemeProvider>
            <FontProvider>
              <QueryProvider>{children}</QueryProvider>
            </FontProvider>
          </ColorThemeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
