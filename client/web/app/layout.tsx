import type { Metadata } from 'next';
import { headers } from 'next/headers';
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
import { displayFontFaceCss } from '@mantle/web-ui/display-fonts';
import { resolveAppearanceAttrs } from '@mantle/web-ui/appearance';
import { loadBrainAppearance } from '@/lib/appearance';
import { MEMBER_SURFACE_HEADER } from '@/lib/member-surface';

/**
 * ZERO-SECRET client root layout. No DB, no session read — the tab title is
 * the static default (the server app's logged-in metadata personalization
 * doesn't apply here; the shell adopts siteName client-side after /api/shell).
 *
 * The brain's SYSTEM-WIDE appearance (colour theme + display fonts) is
 * rendered straight into the <html> tag: attributes for the ids and inline
 * style for the two font vars, fetched server-to-server from the public
 * GET /api/appearance (cached in lib/appearance.ts). The document arrives
 * correct — no before-paint scripts, no localStorage, nothing to coordinate;
 * the client providers read these attributes back on mount. That fetch is
 * per-request state, so the layout is explicitly dynamic — which this app
 * effectively is anyway (/env.js already serves per-request runtime config).
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Mantle',
  description: 'Your tree of everything.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [appearance, hdrs] = await Promise.all([
    loadBrainAppearance().then(resolveAppearanceAttrs),
    headers(),
  ]);
  // Member surfaces (/team, /hub — flagged by the middleware) carry the
  // owner-brand lock in the ORIGINAL HTML, so the providers see it at mount
  // and never start visitor-local behavior (the random-theme toggle) over the
  // brand. The attributes themselves are the same for every surface — the
  // brain has ONE appearance.
  const memberSurface = hdrs.get(MEMBER_SURFACE_HEADER) === '1';
  const fontStyle: Record<string, string> = {};
  if (appearance.fontVars.wordmark) fontStyle['--font-wordmark'] = appearance.fontVars.wordmark;
  if (appearance.fontVars.pageTitle) fontStyle['--font-page-title'] = appearance.fontVars.pageTitle;
  return (
    <html
      lang="en"
      className="h-full"
      suppressHydrationWarning
      data-color-theme={appearance.colorTheme}
      data-color-theme-owner={memberSurface ? '1' : undefined}
      data-font-logo={appearance.fontLogo}
      data-font-title={appearance.fontTitle}
      style={fontStyle as React.CSSProperties}
    >
      <head>
        {/* Runtime config FIRST and BLOCKING — window.__MANTLE_ENV__ (api base,
            flags) must exist before any bundle code runs. Served per-request by
            app/env.js/route.ts from process.env: one image, any server origin. */}
        <Script src="/env.js" strategy="beforeInteractive" />
        {/* Selectable wordmark/title fonts: @font-face declarations (lazy — a
            file downloads only when a face is actually painted). */}
        <style dangerouslySetInnerHTML={{ __html: displayFontFaceCss() }} />
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
