import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getOwnerOr401 } from '@/lib/auth';
import { renderAvatarSvg } from '@/lib/avatar-svg';
import { db, agents } from '@mantle/db';

// Server-render the agent's boring-avatars SVG so non-web clients (the mobile
// companion) can show the same avatar. We render via a pure string generator
// (lib/avatar-svg.ts) rather than the React `boring-avatars` component: that
// component uses `useId()`, which crashes under react-dom/server inside a route
// handler (mismatched React instances). We pass an explicit hex palette (the
// Clean Slate chart ramp) rather than the theme's oklch tokens, since SVG
// consumers like flutter_svg can't parse oklch.
//
// This sits under the existing `[id]` segment (Next forbids a sibling `[slug]`
// segment). The companion calls it with a slug; the web app could pass a uuid —
// so the key is resolved as id when it looks like a uuid, else as slug.
export const runtime = 'nodejs';

const PALETTE = ['#6366F1', '#4F46E5', '#4338CA', '#3730A3', '#312E81'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;
  const { id: key } = await ctx.params;
  const size = Math.min(
    256,
    Math.max(16, Number(new URL(req.url).searchParams.get('size') ?? 96)),
  );

  const [agent] = await db
    .select({ avatar: agents.avatar, slug: agents.slug })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, owner.id),
        UUID_RE.test(key) ? eq(agents.id, key) : eq(agents.slug, key),
      ),
    )
    .limit(1);

  if (!agent?.avatar) {
    // No generated avatar → let the client fall back to its initials avatar.
    return new Response('no_avatar', { status: 404 });
  }

  const svg = renderAvatarSvg({
    name: agent.avatar.seed || agent.slug,
    variant: agent.avatar.style,
    size,
    colors: PALETTE,
  });

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
