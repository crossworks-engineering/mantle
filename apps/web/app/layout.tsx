import type { Metadata } from 'next';
import './globals.css';
// KaTeX styles for math nodes (inlineMath/blockMath) — bundled locally from the
// npm package (no CDN), matching the self-hosted ethos.
import 'katex/dist/katex.min.css';
import { loadProfilePreferences } from '@mantle/content';
import { fontSans, fontLogo } from '@/lib/fonts';
import { getSessionUser } from '@/lib/auth';
import { isDetachedDev } from '@/lib/auth-constants';
import { ThemeProvider } from '@/components/theme-provider';
import { ColorThemeProvider } from '@/components/color-theme-provider';
import { QueryProvider } from '@/components/query-provider';
import { COLOR_THEME_STORAGE_KEY, DEFAULT_COLOR_THEME } from '@/lib/themes';

const DEFAULT_METADATA: Metadata = {
  title: 'Mantle',
  description: 'Your tree of everything.',
};

/**
 * The browser-tab title follows the profile's Site name (the same preference
 * the header wordmark shows) — but only for a signed-in session. Logged-out
 * surfaces (/login, public /s/[token] links) stay "Mantle" so the brain's name
 * never leaks on a public URL. Detached dev has no local DB, and a metadata
 * failure must never take down rendering, so both fall back to the default.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (isDetachedDev()) return DEFAULT_METADATA;
  try {
    const user = await getSessionUser();
    if (!user) return DEFAULT_METADATA;
    const siteName = (await loadProfilePreferences(user.id)).siteName?.trim();
    return siteName ? { ...DEFAULT_METADATA, title: siteName } : DEFAULT_METADATA;
  } catch {
    return DEFAULT_METADATA;
  }
}

// Apply the stored color theme before paint to avoid a flash.
const colorThemeScript = `(function(){try{var t=localStorage.getItem('${COLOR_THEME_STORAGE_KEY}');if(t&&t!=='${DEFAULT_COLOR_THEME}'){document.documentElement.dataset.colorTheme=t;}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: colorThemeScript }} />
      </head>
      <body className={`${fontSans.variable} ${fontLogo.variable} h-full font-sans antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ColorThemeProvider>
            <QueryProvider>{children}</QueryProvider>
          </ColorThemeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
