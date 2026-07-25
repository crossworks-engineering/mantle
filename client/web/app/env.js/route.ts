import { DEFAULT_COLOR_THEME } from '@mantle/web-ui/lib/themes';
import { resolveFontVars } from '@mantle/web-ui/display-fonts';

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
 * blocking and in <head>, so the stamp lands before first paint. When the
 * fetch succeeds it sets `__MANTLE_APPEARANCE__`, and the layout's
 * localStorage prepaint scripts yield — server truth wins even when that
 * truth is "default", or a stale local copy would override a theme the admin
 * changed from another browser. When the server tier is unreachable the flag
 * is absent and localStorage remains the fallback, exactly as before the
 * carve. Branding is not secret; the endpoint is public for this reason.
 */
export const dynamic = 'force-dynamic';

type Appearance = { colorTheme: string | null; fontLogo: string | null; fontTitle: string | null };

/**
 * In-process cache: /env.js is on the critical path of every full page load
 * and branding changes seldom. Successes are cached 30s so an admin's change
 * shows up promptly; failures are cached 5s (keeping any last-known-good
 * value) so an unreachable server tier costs ONE 2s timeout per window, not a
 * 2s first-paint stall on every load until it recovers.
 */
const TTL_OK_MS = 30_000;
const TTL_FAIL_MS = 5_000;
let cached: { at: number; ok: boolean; value: Appearance | null } | null = null;

async function loadAppearance(origin: string): Promise<Appearance | null> {
  if (!origin) return null; // monolith/same-origin — the server app stamps its own
  const now = Date.now();
  if (cached && now - cached.at < (cached.ok ? TTL_OK_MS : TTL_FAIL_MS)) return cached.value;
  try {
    const res = await fetch(`${origin}/api/appearance`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      cached = { at: now, ok: false, value: cached?.value ?? null };
      return cached.value;
    }
    const value = (await res.json()) as Appearance;
    cached = { at: now, ok: true, value };
    return value;
  } catch {
    // Server tier slow or down — remember the failure (short TTL) and serve
    // the last known value if we have one, else no stamp and the localStorage
    // fallback does its job. A page must never fail to load over branding.
    cached = { at: now, ok: false, value: cached?.value ?? null };
    return cached.value;
  }
}

/** JS applying the appearance to <html> before paint. Sets the SAME inline
 *  props the localStorage prepaint scripts set, plus the flag that makes
 *  those scripts yield — one authority, one contract. */
function stampScript(a: Appearance | null): string {
  if (!a) return '';
  const stmts: string[] = [];
  if (a.colorTheme && a.colorTheme !== DEFAULT_COLOR_THEME) {
    stmts.push(`d.dataset.colorTheme=${JSON.stringify(a.colorTheme)};`);
  }
  const fonts = resolveFontVars(a.fontLogo, a.fontTitle);
  if (fonts.wordmark) {
    stmts.push(`s.setProperty('--font-wordmark',${JSON.stringify(fonts.wordmark)});`);
  }
  if (fonts.pageTitle) {
    stmts.push(`s.setProperty('--font-page-title',${JSON.stringify(fonts.pageTitle)});`);
  }
  // The flag is set even when there is nothing to apply: "the brain uses the
  // defaults" is real server truth, and the localStorage scripts must not
  // repaint a stale non-default copy over it.
  return `window.__MANTLE_APPEARANCE__=1;try{var d=document.documentElement,s=d.style;${stmts.join(
    '',
  )}}catch(e){}`;
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
