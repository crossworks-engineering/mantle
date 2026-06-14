import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Avatar from 'boring-avatars';
import { and, eq } from 'drizzle-orm';
import { requireOwner } from '@/lib/auth';
import { db, agents } from '@mantle/db';

// boring-avatars is a React component; render it to an SVG string server-side so
// non-web clients (the mobile companion) can show the same avatar. We pass an
// explicit hex palette (the Clean Slate chart ramp) rather than the theme's
// oklch tokens, since SVG consumers like flutter_svg can't parse oklch.
export const runtime = 'nodejs';

const PALETTE = ['#6366F1', '#4F46E5', '#4338CA', '#3730A3', '#312E81'];

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const user = await requireOwner();
  const { slug } = await ctx.params;
  const size = Math.min(
    256,
    Math.max(16, Number(new URL(req.url).searchParams.get('size') ?? 96)),
  );

  const [agent] = await db
    .select({ avatar: agents.avatar })
    .from(agents)
    .where(and(eq(agents.ownerId, user.id), eq(agents.slug, slug)))
    .limit(1);

  if (!agent?.avatar) {
    // No generated avatar → let the client fall back to its initials avatar.
    return new Response('no_avatar', { status: 404 });
  }

  const svg = renderToStaticMarkup(
    createElement(Avatar as unknown as (props: Record<string, unknown>) => unknown, {
      name: agent.avatar.seed || slug,
      variant: agent.avatar.style,
      size,
      colors: PALETTE,
    }),
  );

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
