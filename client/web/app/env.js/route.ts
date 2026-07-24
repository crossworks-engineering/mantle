/**
 * Runtime client configuration — `<script src="/env.js">` in the root layout
 * head, BLOCKING, so `window.__MANTLE_ENV__` exists before any bundle code
 * runs. Reads process.env per request (force-dynamic, no-store): ONE prebuilt
 * client image serves any server origin; per-box config is compose env only.
 *
 * Empty apiBase ⇒ same-origin (the monolith / single-host deployment).
 * See @mantle/web-ui/runtime-env for the reader + fallback chain.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const env = {
    apiBase: (process.env.MANTLE_SERVER_ORIGIN ?? '').replace(/\/+$/, ''),
    serverOrigin: (process.env.MANTLE_SERVER_ORIGIN ?? '').replace(/\/+$/, ''),
    turnStreaming: process.env.MANTLE_TURN_STREAMING ?? '',
  };
  return new Response(`window.__MANTLE_ENV__ = ${JSON.stringify(env)};`, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
