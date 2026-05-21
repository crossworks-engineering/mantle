import { type NextRequest } from 'next/server';
import { avatarSvg } from '@/lib/dicebear';

/**
 * Avatar SVG endpoint. Generates a DiceBear avatar from ?style=&seed= and
 * returns it as image/svg+xml. Keeps @dicebear server-side (out of client
 * bundles) and lets the browser cache avatars (deterministic for a given
 * style+seed, so `immutable`). Gated by the session middleware like the rest
 * of the app; the output isn't user-specific (depends only on the query).
 */
export function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const style = (searchParams.get('style') ?? '').slice(0, 64);
  const seed = (searchParams.get('seed') ?? '').slice(0, 200);
  const svg = avatarSvg(style, seed);
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
