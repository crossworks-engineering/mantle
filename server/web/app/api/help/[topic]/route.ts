import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listToolGroupBackrefs } from '@/lib/tool-groups';
import { loadHelpTopic } from '@/lib/help';

/**
 * One screen's help panel. Fetched ONLY when the reader clicks the "?" — the
 * whole point of the feature is that a screen costs nothing extra until then,
 * so this must never be prefetched or folded into a page payload.
 *
 * Cacheable per topic on the client (the markdown changes only on deploy); the
 * grant set can change under it, which is why the response carries the resolved
 * groups rather than the client deriving them.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ topic: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const { topic } = await ctx.params;
  // Which groups any agent actually holds — gates the Assistant section.
  const backrefs = await listToolGroupBackrefs(user.id);
  const granted = new Set(
    [...backrefs.entries()].filter(([, agents]) => agents.length > 0).map(([slug]) => slug),
  );

  const help = await loadHelpTopic(topic, granted);
  if (!help) return NextResponse.json({ error: 'no help for this topic' }, { status: 404 });
  return NextResponse.json({ help });
}
