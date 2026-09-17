import { createHash } from 'node:crypto';
import { APP_VERSION } from '@mantle/client-types/version';
import { NextResponse } from '@/server/http-compat';
import { and, eq } from 'drizzle-orm';
import { getOwnerOr401 } from '@/lib/auth';
import { loadProfilePreferences } from '@mantle/content';
import { renderAvatarSvg, resolveAvatarTint } from '@mantle/share-ui/avatar';
import { db, agents } from '@mantle/db';
import { UUID_RE } from '@mantle/std';

// Server-render the agent's avatar SVG so non-web clients (the mobile
// companion) show the same one the web app does.
//
// This calls the SHARED generator — the very same module the browser renders
// with. That is what the DiceBear move bought: its styles are plain data and
// its renderer is a plain function, so there is no React and no `useId()` to
// crash under a route handler, and the 300-line hand-port of boring-avatars
// that used to live in lib/avatar-svg.ts is gone. One implementation, so the
// companion and the browser cannot drift.
//
// The style and tint are the BRAIN's (Settings → Appearance), not the agent's —
// the stored per-agent style is legacy and deliberately ignored, so every
// avatar in a brain is one visual family. A client with no theme context still
// gets a coherent avatar, because the ramp below is a fixed brand default
// rather than something the caller has to supply.
//
// This sits under the existing `[id]` segment (Next forbids a sibling `[slug]`
// segment). The companion calls it with a slug; the web app could pass a uuid —
// so the key is resolved as id when it looks like a uuid, else as slug.

// Clean Slate's --chart-1..5 (light). The companion has no theme, so it gets
// the default brand ramp. Hex because DiceBear validates colours as hex and
// rejects anything else — which is also why passing the oklch-era tokens here
// would throw. themes.css emits hex, so these stay in step by construction.
const PALETTE = ['#666ed1', '#ae467f', '#ad5700', '#4b830f', '#00889b'];

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;
  const { id: key } = await ctx.params;
  const size = Math.min(256, Math.max(16, Number(new URL(req.url).searchParams.get('size') ?? 96)));

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

  // Fail soft: a brain with unreadable prefs still serves an avatar in the
  // default style rather than 500-ing over branding.
  const prefs = await loadProfilePreferences(owner.id).catch(() => undefined);
  const style = prefs?.avatarStyle;
  const tint = resolveAvatarTint(prefs?.avatarTint);

  // The drawing is a pure function of these inputs PLUS the renderer itself,
  // so the ETag hashes APP_VERSION too — a DiceBear/style pin bump changes
  // what identical inputs draw, and without the salt a revalidating client
  // would 304 onto the old image forever. The URL alone isn't the identity
  // (id + size only), and the old blanket max-age=86400 kept a companion a
  // day stale after a builder edit; max-age=300 bounds staleness at 5 min
  // while capping revalidation traffic (a 304 still pays auth + two reads —
  // per render was too often, per 5 minutes is noise).
  const inputs = {
    v: APP_VERSION,
    seed: agent.avatar.seed || agent.slug,
    parts: agent.avatar.parts ?? null,
    style: style ?? null,
    tint,
    size,
  };
  const etag = `"${createHash('sha1').update(JSON.stringify(inputs)).digest('hex')}"`;
  const headers = {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'private, max-age=300',
    ETag: etag,
  };
  // Tolerate weak validators: a compressing proxy may rewrite the strong tag
  // to W/"…", and a strict compare would silently defeat every 304.
  const inm = req.headers.get('if-none-match');
  if (inm && inm.replace(/^W\//, '') === etag) {
    return new Response(null, { status: 304, headers });
  }

  // Async because style JSON is fetched on demand (avatar.ts) — 50 styles are
  // far too much to hold resident just to serve one avatar. Cached after the
  // first request, and a brain draws one style.
  const svg = await renderAvatarSvg({
    style,
    seed: inputs.seed,
    parts: agent.avatar.parts,
    size,
    ramp: PALETTE,
    tint,
  });

  return new Response(svg, { headers });
}
