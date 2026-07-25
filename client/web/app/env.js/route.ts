import { DEFAULT_COLOR_THEME } from '@mantle/web-ui/lib/themes';
import {
  DEFAULT_LOGO_FONT,
  DEFAULT_TITLE_FONT,
  fontFamilyValue,
} from '@mantle/web-ui/display-fonts';

/**
 * Runtime client configuration — `<script src="/env.js">` in the root layout
 * head, BLOCKING, so `window.__MANTLE_ENV__` exists before any bundle code
 * runs. Reads process.env per request (force-dynamic, no-store): ONE prebuilt
 * client image serves any server origin; per-box config is compose env only.
 *
 * Empty apiBase ⇒ same-origin (the monolith / single-host deployment).
 * See @mantle/web-ui/runtime-env for the reader + fallback chain.
 *
 * It ALSO stamps the brain's system-wide appearance (colour theme + display
 * fonts), fetched server-to-server from the server tier. This script is
 * blocking and in <head>, so the stamp lands before first paint. The
 * localStorage before-paint scripts in the layout stay as the fallback, but
 * they cannot cover the case that matters now: a browser — or, after the carve,
 * an entire ORIGIN — that has never been visited has no cached copy, so
 * without this every first load flashes the default theme until /api/shell
 * resolves. Branding isn't secret, which is why the endpoint is public.
 */
export const dynamic = 'force-dynamic';

type Appearance = { colorTheme: string | null; fontLogo: string | null; fontTitle: string | null };

/** Small in-process cache: /env.js is on the critical path of every full page
 *  load and branding changes seldom, so this avoids a request-per-pageload
 *  against the server tier while still picking an admin's change up promptly. */
const TTL_MS = 30_000;
let cached: { at: number; value: Appearance } | null = null;

async function loadAppearance(origin: string): Promise<Appearance | null> {
  if (!origin) return null; // monolith/same-origin — the server app stamps its own
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  try {
    const res = await fetch(`${origin}/api/appearance`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return cached?.value ?? null;
    const value = (await res.json()) as Appearance;
    cached = { at: now, value };
    return value;
  } catch {
    // Server tier slow or down — serve the last known value if we have one,
    // else emit no stamp and let the localStorage fallback do its job. A page
    // must never fail to load because branding couldn't be fetched.
    return cached?.value ?? null;
  }
}

/** JS that applies the appearance to <html> before paint — mirrors exactly what
 *  the localStorage prepaint scripts do, so the two paths can't disagree. */
function stampScript(a: Appearance | null): string {
  if (!a) return '';
  const out: string[] = [];
  if (a.colorTheme && a.colorTheme !== DEFAULT_COLOR_THEME) {
    out.push(`d.dataset.colorTheme=${JSON.stringify(a.colorTheme)};`);
  }
  if (a.fontLogo && a.fontLogo !== DEFAULT_LOGO_FONT) {
    const v = fontFamilyValue(a.fontLogo);
    if (v) out.push(`s.setProperty('--font-wordmark',${JSON.stringify(v)});`);
  }
  if (a.fontTitle && a.fontTitle !== DEFAULT_TITLE_FONT) {
    const v = fontFamilyValue(a.fontTitle);
    if (v) out.push(`s.setProperty('--font-page-title',${JSON.stringify(v)});`);
  }
  if (!out.length) return '';
  return `try{var d=document.documentElement,s=d.style;${out.join('')}}catch(e){}`;
}

export async function GET() {
  const serverOrigin = (process.env.MANTLE_SERVER_ORIGIN ?? '').replace(/\/+$/, '');
  const env = {
    apiBase: serverOrigin,
    serverOrigin,
    turnStreaming: process.env.MANTLE_TURN_STREAMING ?? '',
  };
  const appearance = await loadAppearance(serverOrigin);
  return new Response(
    `window.__MANTLE_ENV__ = ${JSON.stringify(env)};\n${stampScript(appearance)}`,
    {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  );
}
